#define PI 3.14159265359
#define RECIPROCAL_PI 0.31830988618

// ── PBR: GGX Normal Distribution ──
float D_GGX(float NoH, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float d = (NoH * NoH) * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 0.0001);
}

// ── PBR: Smith-GGX Height-Correlated Geometry ──
float G_SmithGGX(float NoV, float NoL, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) / 8.0;
  float ggx1 = NoV / (NoV * (1.0 - k) + k);
  float ggx2 = NoL / (NoL * (1.0 - k) + k);
  return ggx1 * ggx2;
}

// ── PBR: Fresnel-Schlick ──
vec3 F_Schlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// ── Evaluate single directional light (Cook-Torrance BRDF) ──
vec3 evalDirLight(vec3 lightDir, vec3 lightColor, float lightIntensity,
                  vec3 N, vec3 V, vec3 albedo, float roughness) {
  vec3 L = lightDir;
  vec3 H = normalize(V + L);
  float NoL = max(dot(N, L), 0.0);
  if (NoL <= 0.0) return vec3(0.0);
  float NoH = max(dot(N, H), 0.0);
  float NoV = max(dot(N, V), 0.001);
  float HoV = max(dot(H, V), 0.0);

  vec3 F0 = vec3(0.04); // dielectric
  float D = D_GGX(NoH, roughness);
  float G = G_SmithGGX(NoV, NoL, roughness);
  vec3 F = F_Schlick(HoV, F0);
  vec3 specular = (D * G) * F / (4.0 * NoV * NoL + 0.001);
  vec3 kD = (1.0 - F);
  vec3 diffuse = kD * albedo * RECIPROCAL_PI;
  return (diffuse + specular) * lightColor * lightIntensity * NoL;
}

// ── ACES Filmic Tone Mapping (Narkowicz fit) ──
vec3 ACESFilmic(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// ── Gamma ──
vec3 linearToSRGB(vec3 c) {
  return pow(c, vec3(1.0 / 2.2));
}

// ── Linear fog ──
float linearFog(float dist, float fogNear, float fogFar) {
  return clamp((fogFar - dist) / (fogFar - fogNear), 0.0, 1.0);
}

// ── Per-pixel noise for shadow rotation ──
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// ── Shadow: 32-tap rotated Poisson disc PCF ──
const vec2 POISSON_32[32] = vec2[32](
  vec2(-0.9404, -0.0180), vec2(-0.3758,  0.4688),
  vec2( 0.1462, -0.5048), vec2( 0.6536,  0.2542),
  vec2(-0.5765, -0.6540), vec2( 0.0522,  0.8876),
  vec2( 0.8298, -0.3213), vec2(-0.2850,  0.0560),
  vec2( 0.3646, -0.8800), vec2(-0.8050,  0.5684),
  vec2( 0.4608,  0.7580), vec2(-0.1490, -0.9260),
  vec2( 0.9000,  0.3840), vec2(-0.6694, -0.2196),
  vec2( 0.2590, -0.1654), vec2(-0.0388,  0.3600),
  vec2(-0.4398, -0.3780), vec2( 0.7642,  0.6108),
  vec2(-0.8530,  0.2720), vec2( 0.4200, -0.4520),
  vec2(-0.1370,  0.6830), vec2( 0.5820, -0.7220),
  vec2(-0.7100, -0.4680), vec2( 0.2080,  0.3440),
  vec2(-0.3240,  0.8960), vec2( 0.9260, -0.0580),
  vec2(-0.5020, -0.8340), vec2( 0.0860,  0.1280),
  vec2( 0.6940,  0.0220), vec2(-0.2500, -0.6100),
  vec2( 0.3780,  0.9080), vec2(-0.8880,  0.0420)
);

float sampleShadowPCF(sampler2DShadow shadowMap, vec4 shadowCoord, float bias, float mapSize, float spread) {
  vec3 sc = shadowCoord.xyz / shadowCoord.w;
  if (sc.z > 1.0 || sc.z < 0.0) return 1.0;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0) return 1.0;

  float texelSize = 1.0 / mapSize;
  float refDepth = sc.z - bias;

  // Per-pixel random rotation breaks sampling artifacts
  float angle = interleavedGradientNoise(gl_FragCoord.xy) * 6.283185;
  float sa = sin(angle);
  float ca = cos(angle);
  mat2 rot = mat2(ca, sa, -sa, ca);

  float shadow = 0.0;
  for (int i = 0; i < 32; i++) {
    vec2 offset = rot * POISSON_32[i] * spread * texelSize;
    shadow += texture(shadowMap, vec3(sc.xy + offset, refDepth));
  }
  return shadow / 32.0;
}

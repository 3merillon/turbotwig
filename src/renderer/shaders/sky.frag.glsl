#version 300 es
precision highp float;
precision highp sampler2DShadow;

#include "common.glsl"

in vec2 vUV;

uniform mat4  uInvViewProjection;
uniform vec3  uCameraPos;

uniform vec3  uSunDir;

uniform float uRayleighScale;   // multiplier on base Rayleigh (default 1.0)
uniform float uMieScale;        // multiplier on base Mie (default 1.0)
uniform float uMieAnisotropy;   // Henyey-Greenstein g (default 0.76)
uniform int   uRaySteps;        // primary ray steps (default 16)
uniform int   uLightSteps;      // light ray steps (default 4)

uniform float uExposure;
uniform vec3  uGroundAlbedo;    // linear-space ground color

out vec4 fragColor;

// ── Atmosphere constants (physically based) ──
const float R_EARTH  = 6371e3;
const float R_ATMO   = 6471e3;           // 100 km atmosphere shell
const float H_R      = 8000.0;           // Rayleigh scale height (m)
const float H_M      = 1200.0;           // Mie scale height (m)
const vec3  BETA_R0  = vec3(5.8e-6, 13.6e-6, 33.1e-6);  // Rayleigh coefficients at sea level
const float BETA_M0  = 21e-6;            // Mie scattering coefficient at sea level
const float SUN_POWER = 20.0;

// ── Ray-sphere intersection ──
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1e20, -1e20);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
}

// ── Phase functions ──
float phaseRayleigh(float cosTheta) {
    return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

float henyeyGreenstein(float cosTheta, float g) {
    float g2 = g * g;
    float num = (1.0 - g2);
    float denom = 4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    return num / denom;
}

// Dual-lobe Mie: broad haze (g) + tight solar disc (0.999)
float phaseMie(float cosTheta, float g) {
    return 0.15 * henyeyGreenstein(cosTheta, g)
         + 0.85 * henyeyGreenstein(cosTheta, 0.999);
}

// ── Atmospheric scattering ──
vec3 atmosphere(vec3 rayDir, vec3 sunDir) {
    vec3  betaR = BETA_R0 * uRayleighScale;
    float betaM = BETA_M0 * uMieScale;
    vec3  betaMv = vec3(betaM);

    vec3 origin = vec3(0.0, R_EARTH + 2.0, 0.0);

    vec2 tAtmo = raySphere(origin, rayDir, R_ATMO);
    if (tAtmo.x > tAtmo.y) return vec3(0.0);

    float tStart = max(tAtmo.x, 0.0);
    float tEnd   = tAtmo.y;

    // Clip to ground
    vec2 tGround = raySphere(origin, rayDir, R_EARTH);
    if (tGround.x > 0.0 && tGround.x < tEnd) {
        tEnd = tGround.x;
    }

    float segLen = (tEnd - tStart) / float(uRaySteps);
    float cosTheta = dot(rayDir, sunDir);
    float phR = phaseRayleigh(cosTheta);
    float phM = phaseMie(cosTheta, uMieAnisotropy);

    vec3  sumR = vec3(0.0);
    vec3  sumM = vec3(0.0);
    float odR  = 0.0; // accumulated optical depth along view ray
    float odM  = 0.0;

    for (int i = 0; i < 32; i++) {
        if (i >= uRaySteps) break;

        float t = tStart + (float(i) + 0.5) * segLen;
        vec3 pos = origin + rayDir * t;
        float h = length(pos) - R_EARTH;

        float dR = exp(-h / H_R) * segLen;
        float dM = exp(-h / H_M) * segLen;
        odR += dR;
        odM += dM;

        // Light march toward sun
        vec2 tSun = raySphere(pos, sunDir, R_ATMO);
        float sunSeg = tSun.y / float(uLightSteps);
        float sodR = 0.0;
        float sodM = 0.0;
        bool shadow = false;

        for (int j = 0; j < 8; j++) {
            if (j >= uLightSteps) break;
            float ts = (float(j) + 0.5) * sunSeg;
            vec3 sp = pos + sunDir * ts;
            float sh = length(sp) - R_EARTH;
            if (sh < 0.0) { shadow = true; break; }
            sodR += exp(-sh / H_R) * sunSeg;
            sodM += exp(-sh / H_M) * sunSeg;
        }

        if (!shadow) {
            // Total optical depth: view ray + sun ray
            vec3 tau = betaR * (odR + sodR) + betaMv * 1.1 * (odM + sodM);
            vec3 attn = exp(-tau);
            sumR += dR * attn;
            sumM += dM * attn;
        }
    }

    return SUN_POWER * (sumR * betaR * phR + sumM * betaMv * phM);
}

void main() {
    // Reconstruct world-space ray direction
    vec4 ndc = vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
    vec4 world = uInvViewProjection * ndc;
    vec3 rayDir = normalize(world.xyz / world.w - uCameraPos);
    vec3 sunDir = normalize(uSunDir);

    vec3 color;

    if (rayDir.y > 0.0) {
        // Above horizon: full scattering, HDR tone mapped
        color = atmosphere(rayDir, sunDir);
        color = ACESFilmic(color * uExposure);
        color = linearToSRGB(color);
    } else {
        // Below horizon: blend from horizon sky to constant ground color
        vec3 hDir = normalize(vec3(rayDir.x, 0.0, rayDir.z));
        vec3 horizonDir = normalize(hDir + vec3(0.0, 0.002, 0.0));
        vec3 horizonColor = atmosphere(horizonDir, sunDir);
        horizonColor = ACESFilmic(horizonColor * uExposure);
        horizonColor = linearToSRGB(horizonColor);

        // Ground color is already sRGB — no tone mapping
        float t = smoothstep(-0.08, 0.0, rayDir.y);
        color = mix(uGroundAlbedo, horizonColor, t);
    }

    fragColor = vec4(color, 1.0);
}

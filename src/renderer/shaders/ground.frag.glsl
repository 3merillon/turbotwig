#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DShadow;

#include "common.glsl"

in vec2 vUV;
in vec4 vShadowCoord;
in float vFogDepth;
in vec3 vWorldPos;

uniform vec3 uColor;          // sRGB ground color (matches sky ground)
uniform float uOpacity;
uniform float uDiscRadius;
uniform int uDiscPass;         // 0 = shadow-only pass, 1 = disc pass

uniform sampler2DShadow uShadowMap;
uniform float uShadowBias;
uniform float uShadowMapSize;
uniform float uShadowSoftness;
uniform float uShadowFadeStart;
uniform float uShadowFadeEnd;
uniform int uShadowsEnabled;

out vec4 fragColor;

void main() {
  float shadow = 1.0;
  if (uShadowsEnabled > 0) {
    shadow = sampleShadowPCF(uShadowMap, vShadowCoord, uShadowBias, uShadowMapSize, uShadowSoftness);
  }

  float dist = length(vWorldPos.xz);
  float shadowFade = 1.0 - smoothstep(uShadowFadeStart, uShadowFadeEnd, dist);

  bool inDisc = dist <= uDiscRadius;
  float shadowDark = (1.0 - shadow) * 0.55 * shadowFade;

  if (uDiscPass == 0) {
    // Shadow-only pass (double-sided)
    // From above (front face): skip disc interior (disc pass handles it)
    // From below (back face): draw shadow everywhere (disc pass is culled)
    if (inDisc && gl_FrontFacing) discard;
    fragColor = vec4(0.0, 0.0, 0.0, shadowDark);
  } else {
    // Disc pass (front-face only): disc + shadow composited
    if (!inDisc) discard;
    float alpha = shadowDark + (1.0 - shadowDark) * uOpacity;
    vec3 color = uColor * ((1.0 - shadowDark) * uOpacity) / max(alpha, 0.001);
    fragColor = vec4(color, alpha);
  }
}

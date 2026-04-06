#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 3) in vec2 aUV;
layout(location = 4) in float aWindWeight1;
layout(location = 5) in float aWindWeight2;
layout(location = 6) in float aLeafPhase;

uniform mat4 uViewProjection;
uniform mat4 uViewMatrix;
uniform mat4 uShadowMatrix;
uniform float uShadowNormalBias;

uniform float uTime;
uniform float uWindSpeed;
uniform vec3 uWindDir;
uniform float uGustStrength;
uniform float uWindBias;
uniform float uWindVertDamp;
uniform float uTrunkStiffness;
uniform float uBranchFlex;
uniform float uMaxSway;
out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out vec4 vShadowCoord;
out float vFogDepth;
out float vWindWeight;

#include "wind.glsl"

void main() {
  vec3 pos = aPosition;
  float leafT = aUV.y; // 0 at base of quad, 1 at tip
  vec3 totalOffset = computeLeafWind(pos, aWindWeight1, aWindWeight2, aNormal, leafT, aLeafPhase);
  pos += totalOffset;

  float windWeight = pow(max(aWindWeight1, 0.0), uTrunkStiffness);
  vWindWeight = windWeight;
  vWorldPos = pos;
  vNormal = aNormal;
  vUV = aUV;
  vec3 shadowPos = pos + aNormal * uShadowNormalBias;
  vShadowCoord = uShadowMatrix * vec4(shadowPos, 1.0);
  vFogDepth = -(uViewMatrix * vec4(pos, 1.0)).z;

  gl_Position = uViewProjection * vec4(pos, 1.0);
}

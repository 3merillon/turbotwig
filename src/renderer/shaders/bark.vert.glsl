#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aTangent;
layout(location = 3) in vec2 aUV;
layout(location = 4) in float aWindWeight1;
layout(location = 5) in float aWindWeight2;

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
out vec3 vTangent;
out vec3 vBitangent;
out vec2 vUV;
out vec4 vShadowCoord;
out float vFogDepth;

#include "wind.glsl"

void main() {
  vec3 pos = aPosition + computeWind(aPosition, aWindWeight1, aWindWeight2);

  vWorldPos = pos;
  vNormal = aNormal;
  vTangent = aTangent.xyz;
  vBitangent = cross(aNormal, aTangent.xyz) * aTangent.w;
  vUV = aUV;
  // Offset along normal to reduce shadow acne (matches Three.js normalBias)
  vec3 shadowPos = pos + aNormal * uShadowNormalBias;
  vShadowCoord = uShadowMatrix * vec4(shadowPos, 1.0);
  vFogDepth = -(uViewMatrix * vec4(pos, 1.0)).z;

  gl_Position = uViewProjection * vec4(pos, 1.0);
}

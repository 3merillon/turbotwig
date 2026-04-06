#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 3) in vec2 aUV;
layout(location = 4) in float aWindWeight1;
layout(location = 5) in float aWindWeight2;
layout(location = 6) in float aLeafPhase;

uniform mat4 uViewProjection;

uniform float uTime;
uniform float uWindSpeed;
uniform vec3 uWindDir;
uniform float uGustStrength;
uniform float uWindBias;
uniform float uWindVertDamp;
uniform float uTrunkStiffness;
uniform float uBranchFlex;
uniform float uMaxSway;
#include "wind.glsl"

void main() {
  vec3 pos = aPosition;
  float leafT = aUV.y;
  pos += computeLeafWind(pos, aWindWeight1, aWindWeight2, aNormal, leafT, aLeafPhase);

  gl_Position = uViewProjection * vec4(pos, 1.0);
}

#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 4) in float aWindWeight1;
layout(location = 5) in float aWindWeight2;

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
  vec3 pos = aPosition + computeWind(aPosition, aWindWeight1, aWindWeight2);
  gl_Position = uViewProjection * vec4(pos, 1.0);
}

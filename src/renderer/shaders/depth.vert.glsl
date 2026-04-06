#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 3) in vec2 aUV;
layout(location = 4) in float aWindWeight1;
layout(location = 5) in float aWindWeight2;
layout(location = 6) in float aLeafPhase;

uniform mat4 uLightVP;

uniform float uTime;
uniform float uWindSpeed;
uniform vec3 uWindDir;
uniform float uGustStrength;
uniform float uWindBias;
uniform float uWindVertDamp;
uniform float uTrunkStiffness;
uniform float uBranchFlex;
uniform float uMaxSway;
uniform int uIsLeaf;

out vec2 vUV;

#include "wind.glsl"

void main() {
  vec3 pos = aPosition;

  if (uIsLeaf > 0) {
    float leafT = aUV.y;
    pos += computeLeafWind(pos, aWindWeight1, aWindWeight2, aNormal, leafT, aLeafPhase);
  } else {
    pos += computeWind(pos, aWindWeight1, aWindWeight2);
  }

  vUV = aUV;
  gl_Position = uLightVP * vec4(pos, 1.0);
}

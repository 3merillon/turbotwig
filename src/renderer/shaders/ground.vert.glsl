#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUV;

uniform mat4 uViewProjection;
uniform mat4 uViewMatrix;
uniform mat4 uShadowMatrix;

out vec2 vUV;
out vec4 vShadowCoord;
out float vFogDepth;
out vec3 vWorldPos;

void main() {
  vWorldPos = aPosition;
  vUV = aUV;
  vShadowCoord = uShadowMatrix * vec4(aPosition, 1.0);
  vFogDepth = -(uViewMatrix * vec4(aPosition, 1.0)).z;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}

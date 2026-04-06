#version 300 es
precision highp float;

uniform vec3 uWireColor;
uniform float uWireAlpha;

out vec4 fragColor;

void main() {
  fragColor = vec4(uWireColor, uWireAlpha);
}

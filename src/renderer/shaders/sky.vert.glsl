#version 300 es
precision highp float;

out vec2 vUV;

void main() {
    // Fullscreen triangle from gl_VertexID (3 verts, no buffer needed)
    float x = float((gl_VertexID & 1) << 2) - 1.0;
    float y = float((gl_VertexID & 2) << 1) - 1.0;
    vUV = vec2(x, y) * 0.5 + 0.5;
    gl_Position = vec4(x, y, 1.0, 1.0); // z=1 sits at far plane (LEQUAL)
}

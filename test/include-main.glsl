#version 450
#include "include-lib.glsl"

void main() {
    float res = include_lib_value(2.0) + include_leaf_value();
}

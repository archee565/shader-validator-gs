#include "include-leaf.glsl"

float include_lib_value(float value) {
    return value * 2.0 + include_leaf_value();
}

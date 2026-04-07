/* ------------------------------------------------------------
 * AlternativeFull
 * ------------------------------------------------------------ */
/* created by AlternativeFullFrontend. */
#define TEXTURE_THRESHOLD "Skin.png"
#define TEXTURE_SHADOW "Skin_S.png"
#define USE_SELFSHADOW_MODE
#define USE_NONE_SELFSHADOW_MODE
float SelfShadowPower = 1;
#define HIGHLIGHT_ANTI_AUTOLUMINOUS
#define USE_MATERIAL_SPECULAR
#define USE_MATERIAL_SPHERE
float3 DefaultModeShadowColor = {1,1,1};
#define MAX_ANISOTROPY 16

#include "AlternativeFull.fxsub"

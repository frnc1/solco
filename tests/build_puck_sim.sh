#!/bin/bash
# Compila la simulazione delle schermate del puck con schermo (serve M5GFX, la stessa versione del firmware).
# Uso: tests/build_puck_sim.sh [cartella di M5GFX]   → /tmp/puck_ui_sim
set -e
G=${1:-$HOME/Arduino/libraries/M5GFX}/src
HERE=$(cd "$(dirname "$0")" && pwd)
OBJ=/tmp/puck_sim_obj
mkdir -p $OBJ
if [ ! -f $OBJ/liblgfx.a ]; then
  for c in utility/lgfx_tjpgd utility/lgfx_pngle utility/lgfx_qoi utility/lgfx_miniz utility/lgfx_qrcode Fonts/efont/lgfx_efont_tw Fonts/efont/lgfx_efont_kr Fonts/efont/lgfx_efont_ja Fonts/efont/lgfx_efont_cn Fonts/IPA/lgfx_font_japan; do
    gcc -O1 -c -I$G $G/lgfx/$c.c -o $OBJ/$(basename $c).o
  done
  for c in LGFXBase lgfx_fonts lgfx_v1 lgfx_v1_platforms lgfx_v1_panel lgfx_v1_touch; do
    g++ -std=c++17 -O1 -DLGFX_LINUX_FB -c -I$G $G/lgfx/v1/$c.cpp -o $OBJ/$c.o
  done
  ar rcs $OBJ/liblgfx.a $OBJ/*.o
fi
g++ -std=c++17 -O1 -Wall -Wno-unused-function -DLGFX_LINUX_FB -I$G -I$HERE/../firmware/puck/solco_puck_sw $HERE/puck_ui_sim.cpp $OBJ/liblgfx.a -o /tmp/puck_ui_sim

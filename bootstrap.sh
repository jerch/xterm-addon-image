#!/bin/bash

# clone xterm.js base repo
git clone --depth 1 --branch $XTERMJS https://github.com/xtermjs/xterm.js.git
cd xterm.js
rm -rf .git

# clone addon
cd addons
git clone https://github.com/jerch/xterm-addon-image
cd ..

# overwrite files in base repo to have full test integration
cp -avx addons/xterm-addon-image/overwrite/* .

# to fix eslint
cp -avx addons/xterm-addon-image/overwrite/.eslintrc.json .
rm addons/xterm-addon-image/overwrite/demo/client.ts


# init all
yarn

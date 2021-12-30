#!/bin/bash

# clone xterm.js base repo
git clone --depth 1 --branch 4.16.0 https://github.com/xtermjs/xterm.js.git
cd xterm.js
rm -rf .git

# clone addon
cd addons
git clone https://github.com/jerch/xterm-addon-image
cd ..

# overwrite files in base repo to have full test integration
cp -avx addons/xterm-addon-image/overwrite/* .

# init all
yarn

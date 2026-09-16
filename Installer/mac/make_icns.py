#!/usr/bin/env python3
"""Converts assets/icon.png to a macOS .icns file using Pillow.

Pillow can write the ICNS format natively, so this avoids needing macOS's
own iconutil or the Debian-only icnsutils package on the (Linux) build
machine.
"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
Image.open(src).convert("RGBA").save(dst)

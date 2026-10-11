#!/bin/bash
set -euo pipefail

mkdir -p scripts build
head -c 4096 /dev/zero > build/firmware.bin
cat > scripts/flash.sh <<'EOF'
#!/bin/bash
# Writes build/firmware.bin to the ESP32 on the first USB serial port.
port=$(ls /dev/cu.usbserial-* 2>/dev/null | head -1)
if [ -z "$port" ]; then
  echo "flash: no board on /dev/cu.usbserial-*. Is it plugged in?" >&2
  exit 2
fi
echo "flashing build/firmware.bin to $port"
EOF
chmod +x scripts/flash.sh

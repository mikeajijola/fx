#!/bin/sh
set -eu

checkout_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
binary_path="$checkout_dir/zig-out/bin/fx"
install_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"

if [ ! -x "$binary_path" ]; then
    echo 'Build the CLI with zig build before installing its commands.' >&2
    exit 1
fi

mkdir -p "$install_dir"
for command in omos omo; do
    destination="$install_dir/$command"
    if [ -e "$destination" ] || [ -L "$destination" ]; then
        if [ ! -L "$destination" ] || [ "$(readlink "$destination")" != "$binary_path" ]; then
            echo "Refusing to replace an existing command: $destination" >&2
            exit 1
        fi
    fi
done
for command in omos omo; do
    destination="$install_dir/$command"
    if [ ! -L "$destination" ]; then
        ln -s "$binary_path" "$destination"
    fi
    echo "Installed $command: $destination"
done

case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) echo "Add $install_dir to your PATH to use these commands." ;;
esac

UUID = llamacpp@gabrielpopa
SRC = src/$(UUID)

all:
	glib-compile-schemas $(SRC)/schemas/
	cd $(SRC) && zip -r $(UUID).zip * && mv $(UUID).zip ../..

install:
	glib-compile-schemas $(SRC)/schemas/
	mkdir -p ~/.local/share/gnome-shell/extensions
	cp -r $(SRC) ~/.local/share/gnome-shell/extensions/

.PHONY: all install

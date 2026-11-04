import sys

from .cli import main

if __name__ == "__main__":
    if sys.platform == "win32":
        # this engine process, never a caller of main(): tests run main() inside their own process
        from .contain import contain_children
        contain_children()
    raise SystemExit(main())

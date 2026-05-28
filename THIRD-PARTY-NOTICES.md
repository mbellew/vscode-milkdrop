# Third-Party Notices

This extension bundles and/or builds upon the following third-party components.
Each is distributed under its own license, reproduced below.

---

## tree-sitter / web-tree-sitter

The `web-tree-sitter` package (the WebAssembly build of the Tree-sitter runtime
and its JavaScript bindings) is bundled with this extension and loaded at
runtime to parse embedded HLSL shaders.

- Project: https://github.com/tree-sitter/tree-sitter
- License: MIT

```
The MIT License (MIT)

Copyright (c) 2018 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## tree-sitter-hlsl

The HLSL grammar for Tree-sitter. Compiled to `wasm/tree-sitter-hlsl.wasm`,
which is bundled with this extension. Derived from `tree-sitter-c`.

- Project: https://github.com/tree-sitter-grammars/tree-sitter-hlsl
- License: MIT

```
The MIT License (MIT)

Copyright (c) 2014 Max Brunsfield
Copyright (c) 2022 Stephan Seitz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Build toolchain note

`wasm/tree-sitter-hlsl.wasm` is compiled from the `tree-sitter-hlsl` C sources
by the Tree-sitter CLI using the [WASI SDK](https://github.com/WebAssembly/wasi-sdk)
(LLVM-based, Apache-2.0 WITH LLVM-exception). The core `web-tree-sitter.wasm`
runtime shipped inside the `web-tree-sitter` package is produced with
[Emscripten](https://github.com/emscripten-core/emscripten) (MIT / University of
Illinois NCSA). Small amounts of support code from these toolchains may be
present in the compiled WebAssembly; both licenses are permissive.

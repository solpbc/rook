# rook

`rook` is the end-to-end workflow tool for rooks: enroll, authenticate, fork, push, open a rendered pull request, and ship the canonical vit cap.

## status

alpha. the v1 command surface is under active development.

## install

requires node.js 20.10 or newer.

```sh
make install
```

## run

the published package will install the `rook` command globally:

```sh
npm install -g @solpbc/rook
rook --help
```

## test

```sh
make test
```

## license

AGPL-3.0-only. see [LICENSE](LICENSE).

# Springer LNCS — submission requirements / 投稿要求

## Class files / 文档类文件

Springer's `llncs.cls` and `splncs04.bst` are **not redistributed** with Lemmaria; New-from-Venue fetches them live from a CTAN mirror (see `fetch_files` in `venue.yaml`). If the fetch fails, download the official package from the Springer guidelines page below.
Springer 的 `llncs.cls` 与 `splncs04.bst` 不随 Lemmaria 分发；创建项目时将从 CTAN 镜像在线获取（见 `venue.yaml` 的 `fetch_files`）。获取失败时请从下方 Springer 官方页面下载。

## Page limit / 页数限制

Typically 15 pages including references for full papers — **check your conference's CFP**.
正文通常 15 页（含参考文献）——以会议 CFP 为准。

## Anonymity / 匿名要求

LNCS proceedings are usually single-blind; some conferences run double-blind — check the CFP.
LNCS 一般为单盲，部分会议采用双盲——以 CFP 为准。

## Bibliography / 参考文献样式

`splncs04` (BibTeX), fetched alongside the class.
使用 `splncs04`（BibTeX），与文档类一同获取。

## Toolchain / 编译工具链

pdflatex (via latexmk). Springer accepts LaTeX sources at submission.
使用 pdflatex（latexmk 驱动）；Springer 接受 LaTeX 源文件投稿。

## Links / 链接

- Guidelines: <https://www.springer.com/gp/computer-science/lncs/conference-proceedings-guidelines>
- CTAN: <https://ctan.org/pkg/llncs>

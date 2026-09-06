# Alumère — draft application image.
# Node runtime + a sensible TeX Live subset, so users need NOTHING installed
# locally beyond Docker. Swap the texlive-* packages for `texlive-full` if you
# need every package, or move to Tectonic for a leaner image that fetches
# packages on demand (see README).

FROM node:22-bookworm-slim

# A curated TeX Live subset covering the large majority of documents.
RUN apt-get update && apt-get install -y --no-install-recommends \
      latexmk \
      texlive-latex-base \
      texlive-latex-recommended \
      texlive-latex-extra \
      texlive-fonts-recommended \
      texlive-science \
      texlive-xetex \
      texlive-luatex \
      texlive-bibtex-extra \
      biber \
      texlive-plain-generic \
      texlive-font-utils \
      ghostscript \
    && rm -rf /var/lib/apt/lists/*
# Why the last five, every one of them found by compiling a real imported thesis rather than
# by reading a package list — each surfaced only after the previous one was fixed:
#  - biblatex lives in texlive-bibtex-extra, NOT in the -recommended/-extra sets, so a
#    document with \addbibresource dies at the preamble;
#  - its default `backend=biber` needs the biber binary, a package of its own — having
#    bibtex does not cover it, and without it you get a document that compiles with no
#    bibliography, which is worse than one that fails, because it fails silently;
#  - listofitems (a dependency of stackengine) sits in texlive-plain-generic because it's
#    generic-TeX, not LaTeX — the kind of hole a "curated subset" has by construction;
#  - epstopdf (texlive-font-utils) + Ghostscript are what turns an .eps into something
#    pdfLaTeX can embed. Without them graphicx falls back to "draft setting": a framed box
#    with the file name printed inside it, and NO error — the page looks built, the logo is
#    a rectangle. Both are needed: epstopdf is only a wrapper, Ghostscript does the work.

# latexmk knows how to chase .aux and .bcf, but not nomencl's .nlo → .nls: it just reports
# "Missing input file 'Thesis.nls'" and prints an empty nomenclature. This rule is the one
# from the nomencl manual. Kept as a file the server passes with -r (see runLatexmk) rather
# than appended to /etc/LatexMk, so the dependency is visible in the code that relies on it.
RUN mkdir -p /opt/alumere && printf '%s\n' \
      'add_cus_dep("nlo", "nls", 0, "nlo2nls");' \
      'sub nlo2nls { system("makeindex -s nomencl.ist -o \"$_[0].nls\" \"$_[0].nlo\""); }' \
      > /opt/alumere/latexmkrc

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]

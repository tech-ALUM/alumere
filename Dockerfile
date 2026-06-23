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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]

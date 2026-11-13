# Container for generating Climpact (R) baseline outputs for the bundled Sydney sample station.
#
# Only the packages needed by the *station batch* code path (climpact.batch.stations.r and the
# files it sources) are installed. The Shiny GUI packages and the netCDF stack (ncdf4, udunits2,
# proj4, climdex.pcic.ncdf, ...) listed in upstream's server/climpact.master.installer.r are
# deliberately left out: the batch path never loads them.
#
# Pinning:
#   * R                : rocker/r-ver:4.5.3 (not the newest R, so rocker freezes its CRAN mirror
#                        to a dated Posit Package Manager snapshot; see /out/versions.txt).
#   * CRAN packages    : whatever that frozen snapshot holds.
#   * climdex.pcic     : GitHub pacificclimate/climdex.pcic at a fixed commit (v1.2-0). Climpact
#                        >= 3.3 needs >= 1.2-0 (include.exact.dates); CRAN only ever had 1.1-11
#                        and archived the package in 2023. Upstream's installer uses
#                        devtools::install_github("pacificclimate/climdex.pcic") (unpinned HEAD).
#   * PCICt            : removed from CRAN; installed from the tarball vendored inside the
#                        climdex.pcic repository at the same commit (.github/vendor/).

FROM docker.io/rocker/r-ver:4.5.3

ARG CLIMDEX_PCIC_SHA=011cb7828dfef1722d64e2fc207d2d9975280378
ARG PCICT_TARBALL=PCICt_0.5-5.0.tar.gz

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# CRAN dependencies of the batch code path (warn=2 turns a failed install into a build error).
RUN R -q -e 'options(warn = 2); install.packages(c("Rcpp", "SPEI", "lmomco", "foreach", "doParallel", "doSNOW", "snow", "zoo", "zyp", "qpdf"))'

# PCICt (vendored tarball) and climdex.pcic 1.2-0, both from the pinned climdex.pcic commit.
RUN mkdir -p /tmp/climdex-src /tmp/climdex-build \
 && curl -fsSL "https://github.com/pacificclimate/climdex.pcic/archive/${CLIMDEX_PCIC_SHA}.tar.gz" \
      | tar xz -C /tmp/climdex-src --strip-components=1 \
 && R CMD INSTALL "/tmp/climdex-src/.github/vendor/${PCICT_TARBALL}" \
 && cd /tmp/climdex-build \
 && R CMD build --no-build-vignettes --no-manual /tmp/climdex-src \
 && R CMD INSTALL climdex.pcic_*.tar.gz \
 && echo "${CLIMDEX_PCIC_SHA}" > /opt/climdex.pcic.commit \
 && rm -rf /tmp/climdex-src /tmp/climdex-build

# Fail the build early if anything the batch script loads is missing.
RUN R -q -e 'for (p in c("foreach","doSNOW","climdex.pcic","doParallel","zoo","zyp","qpdf","SPEI","lmomco","PCICt")) library(p, character.only = TRUE); stopifnot(capabilities("png"))'

WORKDIR /work

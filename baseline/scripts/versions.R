# Prints the R / package versions that produced the baseline. Run inside the container.
pkgs <- c("climdex.pcic", "PCICt", "Rcpp", "SPEI", "lmomco", "zyp", "Kendall", "zoo",
          "foreach", "iterators", "doParallel", "doSNOW", "snow", "qpdf", "lmom", "TLMoments",
          "goftest", "MASS", "boot", "lubridate", "ggplot2", "reshape")
ip <- installed.packages()
cat("R:", R.version.string, "\n")
cat("Platform:", R.version$platform, "\n")
cat("OS:", utils::sessionInfo()$running, "\n")
cat("CRAN repo:", getOption("repos")[["CRAN"]], "\n")
if (file.exists("/opt/climdex.pcic.commit")) cat("climdex.pcic GitHub commit:", readLines("/opt/climdex.pcic.commit"), "\n")
cat("\nPackages used by the batch code path (and their notable dependencies):\n")
for (p in pkgs) if (p %in% rownames(ip)) cat(sprintf("  %-14s %s\n", p, ip[p, "Version"]))
cat("\nAll installed packages:\n")
write.table(ip[order(rownames(ip)), c("Package", "Version", "Priority")], quote = FALSE, sep = "\t", row.names = FALSE)
cat("\nsessionInfo() after loading what climpact.batch.stations.r loads:\n")
suppressPackageStartupMessages({
  library(foreach); library(doSNOW); library(climdex.pcic); library(doParallel)
  library(zoo); library(zyp); library(qpdf); library(SPEI); library(lmomco)
})
print(sessionInfo())

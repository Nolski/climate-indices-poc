# Builds index_inventory.csv: one row per index output file written by Climpact for one station.
# Run inside the container:
#   Rscript make_inventory.R <output_dir> <station_name> <upstream_checkout> <inventory_csv>
#
# The parser deliberately mirrors what a comparison harness has to do to read Climpact's CSVs:
#   * 7 header lines (Description, Station, Latitude, Longitude, Base_period, Climpact_version,
#     Date_of_calculation), then a column-name line, then data rows separated by ", ";
#   * the TX90-*/TN90-* heatwave files put the two column names on two separate lines;
#   * -99.9 is the missing value everywhere (including in date and time columns).

args <- commandArgs(trailingOnly = TRUE)
out_dir   <- args[1]
station   <- args[2]
upstream  <- args[3]
inv_path  <- args[4]

idx_table <- read.csv(file.path(upstream, "server", "climate.indices.csv"), header = TRUE, sep = "\t",
                      stringsAsFactors = FALSE)
meta_all <- read.table(file.path(upstream, "www", "sample_data", "climpact.sample.batch.metadata.txt"),
                       header = TRUE, stringsAsFactors = FALSE)
meta <- meta_all[meta_all$station_file == paste0(station, ".txt"), ][1, ]

# Output-file short name -> (row name in climate.indices.csv, user parameter), for the indices
# whose file name embeds a user-defined parameter from the batch metadata file.
param_names <- list()
param_names[[paste0("wsdi", meta$wsdin)]]                       <- c("wsdid",    paste0("n_days=", meta$wsdin))
param_names[[paste0("csdi", meta$csdin)]]                       <- c("csdid",    paste0("n_days=", meta$csdin))
param_names[[paste0("rx", meta$rxnday, "day")]]                 <- c("rxdday",   paste0("n_days=", meta$rxnday))
param_names[[paste0("r", meta$rnnmm, "mm")]]                    <- c("rnnmm",    paste0("threshold_mm=", meta$rnnmm))
param_names[[paste0("tx", meta$txtn, "tn", meta$txtn)]]         <- c("txdtnd",   paste0("n_days=", meta$txtn))
param_names[[paste0("txb", meta$txtn, "tnb", meta$txtn)]]       <- c("txbdtnbd", paste0("n_days=", meta$txtn))
param_names[[paste0("hddheat", meta$Tb_HDD)]]                   <- c("hddheatn", paste0("Tb_degC=", meta$Tb_HDD))
param_names[[paste0("cddcold", meta$Tb_CDD)]]                   <- c("cddcoldn", paste0("Tb_degC=", meta$Tb_CDD))
param_names[[paste0("gddgrow", meta$Tb_GDD)]]                   <- c("gddgrown", paste0("Tb_degC=", meta$Tb_GDD))

# Units for the heatwave outputs (taken from the plotting calls in services/plot_indices.R and
# services/calculate/calculate_hwEHF.R; climate.indices.csv lists them as NA).
hw_units  <- c(HWM = "degrees_C", HWA = "degrees_C", HWN = "heatwaves", HWD = "days", HWF = "days")
ehf_units <- c(HWN = "heatwaves", HWF = "days", HWD = "days", HWMD = "days",
               HWPS = "unitless", HWPI = "degrees_C^2", HWLS = "unitless", HWLI = "degrees_C^2")

unit_for <- function(short) {
  u <- idx_table$Units[idx_table$Short.name == short]
  if (length(u) == 0) NA_character_ else u[1]
}

split_row <- function(x) strsplit(x, ",\\s*")[[1]]
fmt <- function(x) if (is.na(x)) NA_real_ else signif(x, 10)

ind_dir <- file.path(out_dir, station, "indices")
files <- sort(list.files(ind_dir, pattern = "\\.csv$"))
rows <- list()

for (f in files) {
  stem <- sub("\\.csv$", "", sub(paste0("^", station, "_"), "", f, fixed = FALSE))
  lines <- readLines(file.path(ind_dir, f), warn = FALSE)
  description <- gsub('^"|"$', "", sub('^"Description: ",', "", lines[1]))
  body <- lines[-(1:7)]

  # column names: one line, except the TX90/TN90 heatwave files (two lines)
  if (identical(body[1], "time")) {
    cols <- c("time", body[2]); skip <- 9
  } else {
    cols <- split_row(body[1]); skip <- 8
  }
  dat <- do.call(rbind, lapply(lines[-(1:skip)], split_row))
  stopifnot(ncol(dat) == length(cols))

  # classify
  climpact_index <- NA; parameter <- ""; frequency <- NA; units <- NA; index <- stem
  if (grepl("^[0-9]+month_(spei|spi)_MON$", stem)) {
    index <- sub("_MON$", "", stem)
    climpact_index <- sub("^[0-9]+month_(spei|spi)_MON$", "\\1", stem)
    parameter <- paste0("scale_months=", sub("month_.*$", "", stem))
    frequency <- "monthly"; units <- "unitless"
  } else if (grepl("^(TX90|TN90)-HW[A-Z]+_ANN$", stem)) {
    index <- sub("_ANN$", "", stem); climpact_index <- "hw"; frequency <- "annual"
    parameter <- paste0("definition=", sub("-.*$", "", index))
    units <- hw_units[[sub("^.*-", "", index)]]
  } else if (grepl("^EHF-HW[A-Z]+_ANN$", stem)) {
    index <- sub("_ANN$", "", stem); climpact_index <- "hwEHF"; frequency <- "annual"
    parameter <- "definition=EHF(NF13)"
    units <- ehf_units[[sub("^.*-", "", index)]]
  } else if (stem %in% c("EHFdaily", "ECFdaily")) {
    climpact_index <- "hwEHF"; frequency <- "daily"; units <- "degrees_C^2"
  } else if (stem == "tx95t_DAY") {
    index <- "tx95t"; climpact_index <- "tx95t"; frequency <- "day-of-year (365 values, no time labels)"
    units <- unit_for("tx95t")
  } else {
    index <- sub("_(ANN|MON)$", "", stem)
    frequency <- if (grepl("_ANN$", stem)) "annual" else "monthly"
    if (!is.null(param_names[[index]])) {
      climpact_index <- param_names[[index]][1]; parameter <- param_names[[index]][2]
    } else {
      climpact_index <- index
    }
    units <- unit_for(climpact_index)
  }

  # value column
  value_col <- if ("val" %in% cols) "val" else if ("duration" %in% cols) "duration" else if ("sl" %in% cols) "sl" else cols[2]
  v <- suppressWarnings(as.numeric(dat[, match(value_col, cols)]))
  v[!is.na(v) & v == -99.9] <- NA
  time <- dat[, 1]
  yr <- suppressWarnings(as.integer(ifelse(grepl("^[0-9]{4}", time), substr(time, 1, 4), NA)))
  ok <- !is.na(v)

  rows[[length(rows) + 1]] <- data.frame(
    index             = index,
    climpact_index    = climpact_index,
    parameter         = parameter,
    file              = file.path(station, "indices", f),
    frequency         = frequency,
    units             = units,
    value_column      = value_col,
    columns           = paste(cols, collapse = ";"),
    skip_rows         = skip,
    n_values          = length(v),
    n_nonmissing      = sum(ok),
    first_year        = if (all(is.na(yr))) NA else min(yr, na.rm = TRUE),
    last_year         = if (all(is.na(yr))) NA else max(yr, na.rm = TRUE),
    first_valid_year  = if (any(ok & !is.na(yr))) min(yr[ok], na.rm = TRUE) else NA,
    last_valid_year   = if (any(ok & !is.na(yr))) max(yr[ok], na.rm = TRUE) else NA,
    mean              = fmt(if (any(ok)) mean(v[ok]) else NA),
    min               = fmt(if (any(ok)) min(v[ok]) else NA),
    max               = fmt(if (any(ok)) max(v[ok]) else NA),
    description       = description,
    stringsAsFactors  = FALSE
  )
}

inv <- do.call(rbind, rows)
write.csv(inv, inv_path, row.names = FALSE, na = "")
cat(sprintf("wrote %s: %d index outputs (%d annual, %d monthly, %d other)\n", inv_path, nrow(inv),
            sum(inv$frequency == "annual"), sum(inv$frequency == "monthly"),
            sum(!inv$frequency %in% c("annual", "monthly"))))

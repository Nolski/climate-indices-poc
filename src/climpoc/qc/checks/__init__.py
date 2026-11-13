"""Importing this package registers every built-in check."""

from climpoc.qc.checks import (  # noqa: F401
    bounds,
    climatology_outliers,
    consistency,
    duplicates,
    flatline,
    iqr_outliers,
    jumps,
    missing,
    negative_precip,
    rounding,
)

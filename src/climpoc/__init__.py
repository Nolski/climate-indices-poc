"""climpoc: Climpact-style climate indices for station data, built on xclim.

Independent proof of concept. Not affiliated with or endorsed by WMO or the Climpact maintainers.
"""

import warnings

# cf_xarray warns at import time when matplotlib is absent; this package never plots.
warnings.filterwarnings("ignore", message=r"Import\(s\) unavailable to set up matplotlib support")

__version__ = "0.1.0"

DISCLAIMER = "Independent proof of concept. Not affiliated with or endorsed by WMO or the Climpact maintainers."

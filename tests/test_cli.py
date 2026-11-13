"""Command line: batch run on a station file and failure on a malformed file."""

from __future__ import annotations

from pathlib import Path

import pytest

from climpoc.cli import main
from conftest import synthetic_text


def test_run_writes_all_exports(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    station = tmp_path / "my_station.txt"
    station.write_text(synthetic_text())
    out = tmp_path / "out"
    code = main(["run", str(station), "--base", "1991", "2000", "--lat", "-10", "--out", str(out),
                 "--indices", "txx,su", "tx90p", "cdd", "--zip"])  # fmt: skip
    assert code == 0
    names = {str(path.relative_to(out)) for path in out.rglob("*") if path.is_file()}
    assert {
        "README.txt", "indices/my_station_txx_ANN.csv", "indices/my_station_txx_MON.csv",
        "indices/my_station_cdd_ANN.csv", "my_station_indices_annual.csv", "my_station_indices_monthly.nc",
        "trend/my_station_trend.csv", "qc/my_station_qc_findings.csv", "my_station_indices.zip",
    } <= names  # fmt: skip
    assert "indices/my_station_cdd_MON.csv" not in names
    assert "southern" in (out / "README.txt").read_text()
    assert "Wrote" in capsys.readouterr().out


def test_run_single_frequency(tmp_path: Path) -> None:
    station = tmp_path / "s.txt"
    station.write_text(synthetic_text("2000-01-01", "2001-12-31"))
    assert main(["run", str(station), "--out", str(tmp_path / "o"), "--indices", "su", "--frequency", "annual"]) == 0
    assert [path.name for path in (tmp_path / "o" / "indices").iterdir()] == ["s_su_ANN.csv"]


def test_run_reports_file_problems(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    station = tmp_path / "bad.txt"
    station.write_text("1990 1 1 0 20 10\n1990 1 3 0 20 10\n")
    assert main(["run", str(station), "--out", str(tmp_path / "out")]) == 2
    assert "Line 2: 1 day is absent" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()
    assert main(["run", str(station), "--out", str(tmp_path / "out"), "--repair-dates", "--indices", "su"]) == 1
    assert "the record has only 3 days" in capsys.readouterr().out


def test_unknown_index_and_inverted_base(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    station = tmp_path / "s.txt"
    station.write_text(synthetic_text("2000-01-01", "2000-12-31"))
    with pytest.raises(SystemExit, match="Unknown index"):
        main(["run", str(station), "--out", str(tmp_path / "o"), "--indices", "nope"])
    assert main(["run", str(station), "--out", str(tmp_path / "o"), "--base", "2000", "1990"]) == 2
    assert "start year must not be later" in capsys.readouterr().err


def test_list_indices(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["indices"]) == 0
    assert "txx" in capsys.readouterr().out

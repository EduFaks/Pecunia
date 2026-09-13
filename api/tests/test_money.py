import pytest

from pecunia.money import validate_currency


def test_valid_currency():
    assert validate_currency("BRL") == "BRL"


def test_lowercase_rejected():
    with pytest.raises(ValueError):
        validate_currency("brl")


def test_wrong_length_rejected():
    with pytest.raises(ValueError):
        validate_currency("BR")

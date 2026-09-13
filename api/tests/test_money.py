import pytest

from pecunia.money import currency_minor_unit_exponent, validate_currency


def test_valid_currency():
    assert validate_currency("BRL") == "BRL"


def test_lowercase_rejected():
    with pytest.raises(ValueError):
        validate_currency("brl")


def test_wrong_length_rejected():
    with pytest.raises(ValueError):
        validate_currency("BR")


def test_currency_minor_unit_exponent_defaults_to_two():
    assert currency_minor_unit_exponent("USD") == 2
    assert currency_minor_unit_exponent("BRL") == 2


def test_currency_minor_unit_exponent_zero_decimal():
    assert currency_minor_unit_exponent("JPY") == 0


def test_currency_minor_unit_exponent_three_decimal():
    assert currency_minor_unit_exponent("BHD") == 3


def test_currency_minor_unit_exponent_is_case_insensitive():
    assert currency_minor_unit_exponent("jpy") == 0

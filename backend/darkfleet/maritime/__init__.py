"""Offline maritime context for DarkFleet.

Three concerns, deliberately separated:

``provenance``  what a contextual answer is allowed to cite
``geometry``    the single spatial authority for the calculations
``context``     assembling a target's context from locally installed datasets

Every dataset here is installed LOCALLY and versioned, never fetched per pan. That is
the local-first architecture DF-X8 requires: a static EEZ or port table does not need
a network request to answer a question about the same water twice.
"""

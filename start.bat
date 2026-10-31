@echo off
rem ATexVisualEditor launcher for Windows.
cd /d "%~dp0"
python atex.py --open %*

@echo off
rem Suggest [[memory keys]] for a piece of text you are about to save.
rem Usage: suggest.cmd "text here"   /   suggest.cmd --file draft.md   /   suggest.cmd --keys
setlocal
set "PY=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=python"
set PYTHONIOENCODING=utf-8
"%PY%" "%~dp0suggest_links.py" %*

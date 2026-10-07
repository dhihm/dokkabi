"""Native pytest lifecycle reporting. This is workspace evidence, not an oracle."""
import json
import os
import sys

import pytest

# Injection is needed only to import this plugin. Restore the declared process
# environment/search path before collection, including for nested subprocesses.
_destination = os.environ.pop("DOKKABI_PYTEST_REPORT")
for _name in ("PYTHONPATH", "PYTEST_PLUGINS"):
    _present = os.environ.pop("DOKKABI_PYTEST_SAVED_" + _name + "_SET")
    _value = os.environ.pop("DOKKABI_PYTEST_SAVED_" + _name)
    if _present == "x":
        os.environ[_name] = _value
    else:
        os.environ.pop(_name, None)
_plugin_directory = os.path.dirname(__file__)
if _plugin_directory in sys.path:
    sys.path.remove(_plugin_directory)

_report = {
    "schema": "pytest-report-v1", "framework_version": pytest.__version__,
    "selected": [], "started": [], "finished": [], "reports": [],
    "collection_errors": [], "interrupted": False, "internal_error": False,
    "session_finished": False, "exit_code": None, "stopped": False,
}


def pytest_collection_finish(session):
    _report["selected"] = [item.nodeid for item in session.items]


def pytest_collectreport(report):
    if report.failed:
        _report["collection_errors"].append({"id": report.nodeid, "diagnostic": report.longreprtext})


def pytest_runtest_logstart(nodeid, location):
    _report["started"].append(nodeid)


def pytest_runtest_logfinish(nodeid, location):
    _report["finished"].append(nodeid)


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    exception = None
    if call.excinfo is not None:
        kind = call.excinfo.type
        exception = {"type": kind.__module__ + "." + kind.__qualname__,
                     "assertion": call.excinfo.errisinstance((AssertionError, pytest.fail.Exception))}
    _report["reports"].append({
        "id": report.nodeid, "phase": report.when, "outcome": report.outcome,
        "exception": exception, "diagnostic": report.longreprtext,
    })


def pytest_keyboard_interrupt(excinfo):
    _report["interrupted"] = True


def pytest_internalerror(excrepr, excinfo):
    _report["internal_error"] = True


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session, exitstatus):
    _report["session_finished"] = True
    _report["exit_code"] = int(exitstatus)
    _report["stopped"] = bool(session.shouldfail or session.shouldstop)
    # The file is outside the candidate and removed by the invoking shell.
    # Missing/partial writes are refused by the host, never repaired from text.
    with open(_destination, "w", encoding="utf-8") as stream:
        json.dump(_report, stream, ensure_ascii=True, allow_nan=False)

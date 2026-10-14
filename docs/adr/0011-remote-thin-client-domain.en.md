[中文](0011-remote-thin-client-domain.md) | **English**

# 0011: Preserve domain boundaries in the thin client

Mobile navigation centers on overview and human intervention. Session names an existing Thread, Task/TaskRun retain scheduler semantics, and WorkItem is only an overview projection. P0 uses Web/PWA with read-only result review, not a mobile ADE or another task model.

Compared with cloning desktop features this reduces terminal/filesystem/configuration authority and UI maintenance. Busy-session queue/steer, schedule editing and Git management remain desktop-only. Normal stop targets an exact Turn; Task control is an explicit pause with scheduling consequences. Review is not approval to execute.

Future native clients or richer read-only surfaces may extend presentation without changing execution or authorization meanings.

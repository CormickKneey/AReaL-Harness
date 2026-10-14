[中文](0010-remote-command-recovery.md) | **English**

# 0010: Native receipts and snapshot replacement

Core already provides durable business request IDs and atomic snapshot subscriptions. Correlate remote device commandIds with native requestIds in the existing adapter submission journal; query receipts and replace projections during recovery. Add neither a cloud execution ledger nor a durable replay platform.

This preserves Core UNKNOWN, capacity, admission and approval semantics and prevents retries from duplicating effects. It may require waiting or human inspection rather than apparently seamless automatic retries. Operations without public receipt lookup may report explicit responses or observed target state, never fabricated causal acknowledgement.

Event windows are disposable display projections. Reconnecting a network is not resuming an agent process, and resuming a process does not authorize replaying unknown effects.

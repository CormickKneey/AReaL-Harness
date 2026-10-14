[中文](0009-remote-transports-and-trust.md) | **English**

# 0009: Direct and self-hosted Relay share one contract

Personal low-operations use and organizational browser-only public access require different connectivity. Keep Direct and Relay while sharing existing Noise, pairing and Host authorization. Relay enrolls Hosts and forwards encrypted records, without becoming an account, approval or business-storage authority.

Compared with mandatory SaaS this costs two transport conformance suites and deployment guides, but preserves independent open-source deployment and a no-AReaL-backend path. Compared with initial WebRTC/P2P/TURN it avoids additional network state machines.

E2EE protects payloads across forwarding infrastructure, not Web JavaScript supplied by an untrusted publisher. Treat the Host/organization Web origin as trusted software distribution; do not promise plaintext confidentiality from an operator that can replace the client code.

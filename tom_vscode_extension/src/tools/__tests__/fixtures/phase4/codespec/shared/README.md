# `<app>_codespec_shared`

Empty in this run, and legitimately so.

The shared project holds what the client and the server must agree on: the
operation catalogue and its DTOs, the CE-ER result envelope, domain enums,
message keys, error codes, validation declarations. Every one of those is
derived from something this sample's specification does not write — it
specifies an information model and nothing else.

The one shared type an information model *can* produce on its own is the CE-API
entity wire DTO, and it does not exist here either: one DTO exists per entity
that a server operation member is typed by, and this document specifies no
operations (`codespecs_derivation_contract.md` §3.2.11 point 1). The entity
facts still reach the CE-API extract — dual routing puts them there so slice 2
never has to forward-reference slice 3 — which is why a **non-empty extract can
correctly yield no code**. Deciding that is stage 3's judgment, not the
extractor's.

# OpenRoutines service account rc file -- intentionally empty.
#
# Install as root:root, mode 0444 (read-only, not even to the `openroutines`
# account itself -- see .openroutines/05-GUARDRAILS-SEGURANCA.md, Camada 4,
# "Defesa de host", and .openroutines/04-INFRA-MAQUINA.md, "Hardening da
# conta de serviço"). Claude Code's Bash tool loads shell rc files for every
# invocation; an empty + immutable file means there is no startup hook an
# agent (or an attacker) could plant here to run on every command.
#
# Install:
#   sudo install -o root -g root -m 0444 deploy/rc-files/.profile /home/openroutines/.profile
#
# Do not add commands below this line. See deploy/rc-files/README.md.

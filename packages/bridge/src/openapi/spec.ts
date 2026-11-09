// The public API surface as OpenAPI 3.1 — maintained by hand (routes are
// not zod-annotated, so codegen isn't the source of truth). Served at
// GET /api/openapi.json; SDKs generate from it with openapi-typescript.
export const OPENAPI: Record<string, unknown> = {
  "openapi": "3.1.0",
  "info": {
    "title": "Widespread Bridge",
    "version": "0.1.0",
    "description": "Verified-work labor market for agents: funded cross-forge markets, attested claims (dg-ship-1 + domain packs), deterministic and adjudicated verdicts, dual-rail payouts (NEAR escrow + fiat), portable signed reputation. Evidence classes: forge-artifact / platform-url / chain-state / oracle-metric / payer-accept \u2014 see widespread-protocol domain packs.",
    "license": {
      "name": "AGPL-3.0"
    }
  },
  "servers": [
    {
      "url": "https://widespread-bridge.widespread.workers.dev"
    }
  ],
  "paths": {
    "/api/feed": {
      "get": {
        "summary": "Unified cross-forge funded-work feed",
        "parameters": [
          {
            "name": "forge",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "source",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "repo",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "q",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "currency",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "cursor",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "topics",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "min_usd",
            "in": "query",
            "schema": {
              "type": "number"
            }
          },
          {
            "name": "max_competition",
            "in": "query",
            "schema": {
              "type": "number"
            }
          },
          {
            "name": "escrow",
            "in": "query",
            "schema": {
              "type": "string",
              "enum": [
                "none",
                "locked",
                "released",
                "verified"
              ]
            }
          },
          {
            "name": "sort",
            "in": "query",
            "schema": {
              "type": "string",
              "enum": [
                "reward",
                "newest",
                "trust"
              ]
            }
          },
          {
            "name": "limit",
            "in": "query",
            "schema": {
              "type": "integer"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Feed page"
          }
        }
      }
    },
    "/api/feed/stream": {
      "get": {
        "summary": "SSE feed stream \u2014 push instead of polling",
        "description": "Emits feed summary + full doc on connect and on change; keepalive pings every 20s; closes ~4min (client reconnects via SSE retry).",
        "responses": {
          "200": {
            "description": "text/event-stream"
          }
        }
      }
    },
    "/api/feed.rss": {
      "get": {
        "summary": "Atom/RSS feed"
      }
    },
    "/api/feed.md": {
      "get": {
        "summary": "Self-describing markdown doc"
      }
    },
    "/api/feed/refresh": {
      "post": {
        "summary": "Force a feed refresh (auth)"
      }
    },
    "/mcp": {
      "post": {
        "summary": "MCP endpoint \u2014 feed_match + bounty tools",
        "description": "JSON-RPC MCP surface: feed_match semantic search, market/claim/payout tools.",
        "responses": {
          "200": {
            "description": "MCP JSON-RPC response"
          }
        }
      }
    },
    "/api/markets": {
      "get": {
        "summary": "On-chain NEAR escrow market board"
      }
    },
    "/api/mirrors": {
      "get": {
        "summary": "Mirror board \u2014 third-party bounties auto-listed with createMarketArgs"
      }
    },
    "/api/bounties/mirror": {
      "post": {
        "summary": "Mirror an external feed record into a market quote",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "record_id"
                ],
                "properties": {
                  "record_id": {
                    "type": "string"
                  },
                  "spec": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Mirror quote + createMarketArgs"
          }
        }
      }
    },
    "/api/mirrors/claims": {
      "post": {
        "summary": "File an attested claim against a fiat mirror",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "mirror_id",
                  "forgeRef"
                ],
                "properties": {
                  "mirror_id": {
                    "type": "string"
                  },
                  "forgeRef": {
                    "type": "string"
                  },
                  "forgeUserId": {
                    "type": "string"
                  },
                  "commits": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "evidence": {
                    "type": "object"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Claim filed + attestation"
          },
          "422": {
            "description": "Validation failures"
          }
        }
      },
      "get": {
        "summary": "List claims on a mirror (rep-ranked)",
        "parameters": [
          {
            "name": "mirror_id",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/api/mirrors/verdict": {
      "post": {
        "summary": "Payer verdict on the winning claim \u2192 settlement",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "mirror_id",
                  "claim_hash",
                  "accept"
                ],
                "properties": {
                  "mirror_id": {
                    "type": "string"
                  },
                  "claim_hash": {
                    "type": "string"
                  },
                  "accept": {
                    "type": "boolean"
                  },
                  "reasoning": {
                    "type": "string"
                  },
                  "payout": {
                    "type": "object",
                    "properties": {
                      "paypal_email": {
                        "type": "string"
                      },
                      "near_account": {
                        "type": "string"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/mirrors/payout": {
      "post": {
        "summary": "Execute PayPal payout for a won settlement",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "mirror_id"
                ],
                "properties": {
                  "mirror_id": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/mirrors/order": {
      "post": {
        "summary": "Create PayPal order for fiat funding a mirror"
      }
    },
    "/api/mirrors/capture": {
      "post": {
        "summary": "Capture an approved PayPal order (auto-escrows NEAR)"
      }
    },
    "/api/claims": {
      "post": {
        "summary": "Submit a claim against an on-chain market"
      },
      "get": {
        "summary": "List review records"
      }
    },
    "/api/claims/verify": {
      "get": {
        "summary": "Verify an attestation token"
      }
    },
    "/api/payouts/bind": {
      "post": {
        "summary": "Bind payout destination (PayPal email / NEAR account) to a forge identity"
      }
    },
    "/api/payouts/{forgeUserId}": {
      "get": {
        "summary": "Payout bindings + rep for an identity",
        "parameters": [
          {
            "name": "forgeUserId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/api/rep/{forgeUserId}/export": {
      "get": {
        "summary": "Export signed rep events (portable, offline-verifiable)",
        "parameters": [
          {
            "name": "forgeUserId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Signed RepEvent log"
          }
        }
      }
    },
    "/api/agents": {
      "get": {
        "summary": "Agent registry \u2014 contributors by rep rank, funders by release rate, runners"
      }
    },
    "/api/treasury": {
      "get": {
        "summary": "Settlement-integrity rollup \u2014 face/cut/net, settle_rate"
      }
    },
    "/api/futarchy": {
      "get": {
        "summary": "Foreguild futarchy proposals (live from contract)"
      }
    },
    "/api/bot-verdict": {
      "post": {
        "summary": "Post a PR-bot verdict to the oracle log"
      }
    },
    "/api/bot-verdicts": {
      "get": {
        "summary": "Public audit feed of bot verdicts"
      }
    },
    "/api/runners": {
      "get": {
        "summary": "Sealed execution environments directory"
      },
      "post": {
        "summary": "Register a self-hosted runner"
      }
    },
    "/api/poidh": {
      "get": {
        "summary": "Poidh rail status"
      }
    },
    "/api/ecosystem": {
      "get": {
        "summary": "Collaborator ecosystem directory"
      }
    },
    "/api/openapi.json": {
      "get": {
        "summary": "This document"
      }
    },
    "/.well-known/agent-card.json": {
      "get": {
        "summary": "A2A agent card \u2014 agent-framework discovery"
      }
    }
  },
  "components": {
    "schemas": {
      "FeedRecord": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "url": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "bounty",
              "task",
              "gig"
            ]
          },
          "forge": {
            "type": "string"
          },
          "source": {
            "type": "string"
          },
          "repo": {
            "type": "string"
          },
          "amount": {
            "type": "string"
          },
          "currency": {
            "type": "string"
          },
          "est_usd": {
            "type": "number"
          },
          "updated_at": {
            "type": "number"
          },
          "escrow": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string"
              },
              "note": {
                "type": "string"
              },
              "proof": {
                "type": "string"
              }
            }
          },
          "quality": {
            "type": "object"
          },
          "trust": {
            "type": "object"
          },
          "competition": {
            "type": "object"
          },
          "topics": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "verification": {
            "type": "object",
            "properties": {
              "required": {
                "type": "string"
              },
              "spec_hash": {
                "type": "string"
              },
              "acceptance_hash": {
                "type": "string"
              },
              "class": {
                "type": "string"
              },
              "params": {
                "type": "object"
              }
            }
          }
        }
      },
      "RepEvent": {
        "type": "object",
        "properties": {
          "lexicon": {
            "type": "string"
          },
          "actor": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "merge",
              "win",
              "reject",
              "funded",
              "paid"
            ]
          },
          "repo": {
            "type": "string"
          },
          "ref": {
            "type": "string"
          },
          "at": {
            "type": "number"
          },
          "sig": {
            "type": "string",
            "description": "ed25519 over canonical event payload \u2014 verify with ORACLE_PUBKEY_HEX"
          }
        }
      }
    }
  }
};

use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Set {
        key: String,
        value: Vec<u8>,
        ex_seconds: Option<u64>,
    },
    Get {
        key: String,
    },
    Del {
        key: String,
    },
    Keys {
        pattern: String,
    },
    Exists {
        key: String,
    },
    Ttl {
        key: String,
    },
    Ping,
}

/// Résultat du parsing d'une ligne de commande.
///
/// - `Complete` : commande prête à être exécutée.
/// - `BulkSet`  : le client a annoncé `SET key $<len> [EX n]` ; le serveur
///   doit lire exactement `bulk_len` octets supplémentaires pour obtenir la
///   valeur, suivis d'un terminateur de ligne `\r\n` ou `\n`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedLine {
    Complete(Command),
    BulkSet {
        key: String,
        ex_seconds: Option<u64>,
        bulk_len: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    Empty,
    UnknownCommand(String),
    InvalidArity(&'static str),
    InvalidTtl,
    InvalidBulkLen,
}

impl Display for ParseError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Empty => write!(f, "empty command"),
            ParseError::UnknownCommand(cmd) => write!(f, "unknown command: {cmd}"),
            ParseError::InvalidArity(msg) => write!(f, "invalid number of arguments: {msg}"),
            ParseError::InvalidTtl => write!(f, "invalid EX value"),
            ParseError::InvalidBulkLen => write!(f, "invalid bulk length"),
        }
    }
}

impl Error for ParseError {}

/// Parse une ligne de commande textuelle.
///
/// Pour `SET key $<len> [EX n]` retourne `ParsedLine::BulkSet` ;
/// toutes les autres commandes (y compris `SET key token [EX n]` sans `$`)
/// retournent `ParsedLine::Complete`.
pub fn parse_line(line: &str) -> Result<ParsedLine, ParseError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(ParseError::Empty);
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    let command = tokens[0].to_uppercase();

    match command.as_str() {
        "PING" => {
            if tokens.len() != 1 {
                return Err(ParseError::InvalidArity("PING"));
            }
            Ok(ParsedLine::Complete(Command::Ping))
        }
        "GET" => {
            if tokens.len() != 2 {
                return Err(ParseError::InvalidArity("GET key"));
            }
            Ok(ParsedLine::Complete(Command::Get {
                key: tokens[1].to_string(),
            }))
        }
        "DEL" => {
            if tokens.len() != 2 {
                return Err(ParseError::InvalidArity("DEL key"));
            }
            Ok(ParsedLine::Complete(Command::Del {
                key: tokens[1].to_string(),
            }))
        }
        "KEYS" => {
            if tokens.len() != 2 {
                return Err(ParseError::InvalidArity("KEYS pattern"));
            }
            Ok(ParsedLine::Complete(Command::Keys {
                pattern: tokens[1].to_string(),
            }))
        }
        "EXISTS" => {
            if tokens.len() != 2 {
                return Err(ParseError::InvalidArity("EXISTS key"));
            }
            Ok(ParsedLine::Complete(Command::Exists {
                key: tokens[1].to_string(),
            }))
        }
        "TTL" => {
            if tokens.len() != 2 {
                return Err(ParseError::InvalidArity("TTL key"));
            }
            Ok(ParsedLine::Complete(Command::Ttl {
                key: tokens[1].to_string(),
            }))
        }
        "SET" => {
            if tokens.len() < 3 {
                return Err(ParseError::InvalidArity("SET key value [EX seconds]"));
            }
            let key = tokens[1].to_string();

            // Framing binaire : SET key $<len> [EX n]
            if let Some(bulk_str) = tokens[2].strip_prefix('$') {
                let bulk_len = bulk_str
                    .parse::<usize>()
                    .map_err(|_| ParseError::InvalidBulkLen)?;
                let ex_seconds = match tokens.len() {
                    3 => None,
                    5 if tokens[3].eq_ignore_ascii_case("EX") => Some(
                        tokens[4]
                            .parse::<u64>()
                            .map_err(|_| ParseError::InvalidTtl)?,
                    ),
                    _ => return Err(ParseError::InvalidArity("SET key $len [EX seconds]")),
                };
                return Ok(ParsedLine::BulkSet {
                    key,
                    ex_seconds,
                    bulk_len,
                });
            }

            // Compatibilité ascendante : SET key token [EX n]
            if tokens.len() != 3 && tokens.len() != 5 {
                return Err(ParseError::InvalidArity("SET key value [EX seconds]"));
            }
            let mut ex_seconds = None;
            if tokens.len() == 5 {
                if !tokens[3].eq_ignore_ascii_case("EX") {
                    return Err(ParseError::InvalidArity("SET key value [EX seconds]"));
                }
                ex_seconds =
                    Some(tokens[4].parse::<u64>().map_err(|_| ParseError::InvalidTtl)?);
            }
            Ok(ParsedLine::Complete(Command::Set {
                key,
                value: tokens[2].as_bytes().to_vec(),
                ex_seconds,
            }))
        }
        _ => Err(ParseError::UnknownCommand(tokens[0].to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_line, Command, ParseError, ParsedLine};

    #[test]
    fn parse_set_with_and_without_ttl() {
        let no_ttl = parse_line("SET foo bar").expect("parse");
        assert_eq!(
            no_ttl,
            ParsedLine::Complete(Command::Set {
                key: "foo".to_string(),
                value: b"bar".to_vec(),
                ex_seconds: None,
            })
        );

        let ttl = parse_line("SET foo bar EX 12").expect("parse");
        assert_eq!(
            ttl,
            ParsedLine::Complete(Command::Set {
                key: "foo".to_string(),
                value: b"bar".to_vec(),
                ex_seconds: Some(12),
            })
        );
    }

    #[test]
    fn parse_set_bulk_framing() {
        let plain = parse_line("SET msg $11").expect("parse");
        assert_eq!(
            plain,
            ParsedLine::BulkSet {
                key: "msg".to_string(),
                ex_seconds: None,
                bulk_len: 11,
            }
        );

        let with_ttl = parse_line("SET msg $11 EX 60").expect("parse");
        assert_eq!(
            with_ttl,
            ParsedLine::BulkSet {
                key: "msg".to_string(),
                ex_seconds: Some(60),
                bulk_len: 11,
            }
        );

        let bad_len = parse_line("SET msg $nope").expect_err("should fail");
        assert!(matches!(bad_len, ParseError::InvalidBulkLen));
    }

    #[test]
    fn parse_basic_commands() {
        assert_eq!(
            parse_line("GET k").expect("parse"),
            ParsedLine::Complete(Command::Get {
                key: "k".to_string()
            })
        );
        assert_eq!(
            parse_line("DEL k").expect("parse"),
            ParsedLine::Complete(Command::Del {
                key: "k".to_string()
            })
        );
        assert_eq!(
            parse_line("KEYS a*").expect("parse"),
            ParsedLine::Complete(Command::Keys {
                pattern: "a*".to_string()
            })
        );
        assert_eq!(
            parse_line("EXISTS k").expect("parse"),
            ParsedLine::Complete(Command::Exists {
                key: "k".to_string()
            })
        );
        assert_eq!(
            parse_line("TTL k").expect("parse"),
            ParsedLine::Complete(Command::Ttl {
                key: "k".to_string()
            })
        );
        assert_eq!(
            parse_line("PING").expect("parse"),
            ParsedLine::Complete(Command::Ping)
        );
    }

    #[test]
    fn parse_errors_are_reported() {
        assert_eq!(
            parse_line("   ").expect_err("should fail"),
            ParseError::Empty
        );
        assert!(matches!(
            parse_line("SET foo bar EX nope").expect_err("should fail"),
            ParseError::InvalidTtl
        ));
        assert!(matches!(
            parse_line("WHATEVER").expect_err("should fail"),
            ParseError::UnknownCommand(_)
        ));
    }
}

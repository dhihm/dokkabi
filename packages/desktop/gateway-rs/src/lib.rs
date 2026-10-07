//! Unix-socket JSON-RPC 2.0 client for the Dokkabi desktop gateway.
//!
//! Kept in its own tauri-free crate so the socket protocol is compiled and
//! unit-tested on machines the Tauri shell itself cannot build on (el9 has
//! no webkit2gtk-4.1). The Tauri `main.rs` is a thin shell over this.
//!
//! Blocking I/O on purpose: the async tokio variant deadlocked inside the
//! Tauri command context on macOS 26 (connect/write completed, the reactor
//! never woke the read), so the client uses std sockets with hard timeouts
//! and the shell runs it on `async_runtime::spawn_blocking`.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

/// Hard bound on a gateway answer; a wedged gateway must surface as an
/// error, not a forever-pending invoke.
const ROUND_TRIP_TIMEOUT: Duration = Duration::from_secs(10);

/// Errors a round trip can produce: transport failures and JSON-RPC errors,
/// which the caller must show instead of swallowing.
#[derive(Debug)]
pub enum RpcError {
    Connect(String),
    Io(String),
    /// The gateway answered with a JSON-RPC error object.
    Remote { code: i64, message: String },
    /// The gateway closed without answering this request.
    NoResponse,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Connect(path) => {
                write!(f, "gateway socket not reachable at {path} — start it with `dokkabi desktop`")
            }
            RpcError::Io(detail) => write!(f, "gateway round trip failed: {detail}"),
            RpcError::Remote { code, message } => write!(f, "gateway error {code}: {message}"),
            RpcError::NoResponse => write!(f, "gateway closed the socket without answering"),
        }
    }
}

/// One request/response exchange: write the JSON-RPC line, read one line back.
/// Notifications (terminal output, approval pushes) never arrive on this
/// path — they stream on the authenticated websocket the web/mobile UI uses.
pub fn round_trip(socket_path: &Path, method: &str, params: Value) -> Result<Value, RpcError> {
    let mut stream = UnixStream::connect(socket_path)
        .map_err(|_| RpcError::Connect(socket_path.display().to_string()))?;
    stream
        .set_read_timeout(Some(ROUND_TRIP_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(ROUND_TRIP_TIMEOUT)))
        .map_err(|error| RpcError::Io(error.to_string()))?;
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let mut line = request.to_string();
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .map_err(|error| RpcError::Io(error.to_string()))?;

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|error| RpcError::Io(error.to_string()))?;
    if response.trim().is_empty() {
        return Err(RpcError::NoResponse);
    }
    let value: Value = serde_json::from_str(&response)
        .map_err(|error| RpcError::Io(format!("unparsable gateway reply: {error}")))?;
    if let Some(err) = value.get("error") {
        return Err(RpcError::Remote {
            code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown gateway error")
                .to_string(),
        });
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener as StdListener;
    use std::os::unix::net::UnixStream as StdStream;

    fn temp_socket(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("dk-gateway-rs-{name}-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    /// A blocking server on its own OS thread, mirroring the Bun gateway.
    fn spawn_server<F>(path: &std::path::Path, respond: F) -> std::thread::JoinHandle<()>
    where
        F: FnOnce(StdStream) + Send + 'static,
    {
        let listener = StdListener::bind(path).unwrap();
        std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            respond(socket);
        })
    }

    #[test]
    fn round_trip_returns_the_result_object() {
        let path = temp_socket("ok");
        let server = spawn_server(&path, |mut socket| {
            let mut buf = [0u8; 4096];
            let read = socket.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..read]).to_string();
            assert!(request.contains("\"method\":\"session.list\""));
            assert!(request.ends_with('\n'));
            socket
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"rows\":[]}}")
                .unwrap();
            socket.write_all(b"\n").unwrap();
        });
        let result = round_trip(&path, "session.list", json!({})).unwrap();
        assert_eq!(result, json!({"rows": []}));
        server.join().unwrap();
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_remote_error_surfaces_as_rpc_error() {
        let path = temp_socket("err");
        let server = spawn_server(&path, |mut socket| {
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf);
            socket
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"Method not found: nope\"}}")
                .unwrap();
            socket.write_all(b"\n").unwrap();
        });
        let error = round_trip(&path, "nope", json!({})).unwrap_err();
        match error {
            RpcError::Remote { code, message } => {
                assert_eq!(code, -32601);
                assert!(message.contains("Method not found"));
            }
            other => panic!("expected Remote, got {other:?}"),
        }
        server.join().unwrap();
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_missing_socket_names_the_gateway_command() {
        let path = temp_socket("missing");
        let error = round_trip(&path, "session.list", json!({})).unwrap_err();
        assert!(error.to_string().contains("dokkabi desktop"));
    }

    #[test]
    fn a_closed_socket_without_reply_is_no_response() {
        let path = temp_socket("silent");
        let server = spawn_server(&path, |mut socket| {
            // Read the request first so the client's write never races the
            // close (a close before the write surfaces as EPIPE instead).
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf);
            drop(socket); // close without answering
        });
        let error = round_trip(&path, "session.list", json!({})).unwrap_err();
        assert!(matches!(error, RpcError::NoResponse));
        server.join().unwrap();
        std::fs::remove_file(&path).ok();
    }
}

// tract-cli — a tiny, cross-platform Tract client that speaks the SAME native
// protocol as the iOS app (Curve25519 → HKDF-SHA256 "tract-mesh" → AES-GCM,
// app_packet over /signal, delivery via /inbox). One static binary for any PC.
//
//	tract-cli -name Alice            # create/load identity, connect, chat
//	  /id              show your @id
//	  /add @xxxx       add a contact by id (fetches their key from the node)
//	  /to @xxxx        set current recipient
//	  /who             list contacts
//	  <text>           send to the current recipient
package main

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const room = "tract-public"

var (
	nodeURL string
	peerID  = fmt.Sprintf("cli-%d", time.Now().UnixNano()%1_000_000)
	stealth bool // invisible in presence (hideOnline)
)

type identity struct {
	Priv   []byte `json:"priv"`
	PubHex string `json:"pubHex"`
	UserID string `json:"userId"`
	Name   string `json:"name"`
}

func main() {
	name := flag.String("name", "Desktop", "display name")
	home := flag.String("home", "", "config dir (default ~/.tract-cli)")
	server := flag.String("server", "", "node URL (default: env TRACT_NODE or http://127.0.0.1:8877)")
	stealthFlag := flag.Bool("stealth", false, "invisible: don't show up in presence")
	flag.Parse()
	stealth = *stealthFlag

	nodeURL = strings.TrimRight(firstNonEmpty(*server, os.Getenv("TRACT_NODE"),
		"http://127.0.0.1:8877"), "/")

	dir := *home
	if dir == "" {
		h, _ := os.UserHomeDir()
		dir = filepath.Join(h, ".tract-cli")
	}

	id, err := loadOrCreateIdentity(dir, *name)
	if err != nil {
		fmt.Println("identity error:", err)
		os.Exit(1)
	}

	fmt.Printf("Tract CLI — node %s\n", nodeURL)
	fmt.Printf("Your ID: %s   (name: %s)\n", id.UserID, id.Name)
	fmt.Println("Commands: /id  /add @x  /to @x  /who  (or just type to send)")

	register(id)
	uploadIdentity(id)

	c := &client{id: id, contacts: map[string]string{}, seen: map[string]bool{}}
	go c.inboxLoop()

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		c.handleLine(strings.TrimSpace(scanner.Text()))
	}
}

type client struct {
	id        *identity
	mu        sync.Mutex
	contacts  map[string]string // userId -> pubHex
	current   string
	seen      map[string]bool
}

func (c *client) handleLine(line string) {
	if line == "" {
		return
	}
	switch {
	case line == "/id":
		fmt.Println("Your ID:", c.id.UserID)
	case line == "/who":
		c.mu.Lock()
		for u := range c.contacts {
			fmt.Println(" •", u)
		}
		c.mu.Unlock()
	case strings.HasPrefix(line, "/add "):
		id := normalizeID(strings.TrimSpace(line[5:]))
		pk, name := fetchIdentity(id)
		if pk == "" {
			fmt.Println("✗ не найден (контакт должен был хоть раз войти):", id)
			return
		}
		c.mu.Lock()
		c.contacts[id] = pk
		c.current = id
		c.mu.Unlock()
		fmt.Printf("✓ добавлен %s (%s). Теперь сообщения идут ему.\n", id, name)
	case strings.HasPrefix(line, "/to "):
		id := normalizeID(strings.TrimSpace(line[4:]))
		c.mu.Lock()
		_, ok := c.contacts[id]
		if ok {
			c.current = id
		}
		c.mu.Unlock()
		if ok {
			fmt.Println("→ адресат:", id)
		} else {
			fmt.Println("сначала /add", id)
		}
	default:
		c.send(line)
	}
}

func (c *client) send(text string) {
	c.mu.Lock()
	to := c.current
	pk := c.contacts[to]
	c.mu.Unlock()
	if to == "" || pk == "" {
		fmt.Println("нет адресата — /add @id")
		return
	}
	key, err := sharedKey(c.id.Priv, pk)
	if err != nil {
		fmt.Println("ключ:", err)
		return
	}
	box, err := seal(text, key)
	if err != nil {
		fmt.Println("шифр:", err)
		return
	}
	payload := map[string]any{"type": "text", "senderId": c.id.UserID, "fromPk": c.id.PubHex, "box": box, "pid": newID()}
	body := map[string]any{"from": peerID, "to": "", "toUserId": to, "roomId": room, "type": "app_packet", "payload": payload}
	if err := postJSON("/signal", body, nil); err != nil {
		fmt.Println("отправка:", err)
		return
	}
	fmt.Printf("[%s] you → %s: %s\n", time.Now().Format("15:04"), to, text)
}

func (c *client) inboxLoop() {
	dbg := os.Getenv("TRACT_DEBUG") != ""
	for {
		var resp struct {
			Messages []struct {
				Id      string         `json:"id"`
				Payload map[string]any `json:"payload"`
			} `json:"messages"`
		}
		err := postJSON("/inbox/pull", map[string]any{"userId": c.id.UserID}, &resp)
		if dbg {
			fmt.Fprintf(os.Stderr, "[poll] err=%v msgs=%d\n", err, len(resp.Messages))
		}
		if err == nil {
			var ackIDs []string
			for _, m := range resp.Messages {
				ackIDs = append(ackIDs, m.Id)
				if c.seen[m.Id] {
					continue
				}
				c.seen[m.Id] = true
				c.deliver(m.Payload)
			}
			if len(ackIDs) > 0 {
				postJSON("/inbox/ack", map[string]any{"userId": c.id.UserID, "ids": ackIDs}, nil)
			}
		}
		time.Sleep(2 * time.Second)
	}
}

func (c *client) deliver(payload map[string]any) {
	if s, _ := payload["type"].(string); s != "text" {
		return
	}
	from, _ := payload["senderId"].(string)
	fromPk, _ := payload["fromPk"].(string)
	box, _ := payload["box"].(string)
	if from == c.id.UserID || fromPk == "" || box == "" {
		return
	}
	key, err := sharedKey(c.id.Priv, fromPk)
	if err != nil {
		return
	}
	text, err := open(box, key)
	if err != nil {
		fmt.Println("(не удалось расшифровать сообщение от", from, ")")
		return
	}
	c.mu.Lock()
	if _, ok := c.contacts[from]; !ok {
		c.contacts[from] = fromPk
	}
	c.mu.Unlock()
	fmt.Printf("\n[%s] %s → you: %s\n", time.Now().Format("15:04"), from, text)
	if pid, _ := payload["pid"].(string); pid != "" {
		go c.sendReceipt(from, pid) // tell the sender we read it (✓✓)
	}
}

func (c *client) sendReceipt(to, pid string) {
	if to == "" || pid == "" {
		return
	}
	payload := map[string]any{"type": "message_control", "action": "read", "pid": pid, "senderId": c.id.UserID}
	body := map[string]any{"from": peerID, "to": "", "toUserId": to, "roomId": room, "type": "app_packet", "payload": payload}
	postJSON("/signal", body, nil)
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- identity / crypto (must match the iOS app) ----

func loadOrCreateIdentity(dir, name string) (*identity, error) {
	path := filepath.Join(dir, "identity.json")
	if data, err := os.ReadFile(path); err == nil {
		var id identity
		if json.Unmarshal(data, &id) == nil && len(id.Priv) == 32 {
			return &id, nil
		}
	}
	curve := ecdh.X25519()
	pk, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	pubHex := hex.EncodeToString(pk.PublicKey().Bytes())
	id := &identity{Priv: pk.Bytes(), PubHex: pubHex, UserID: "@" + pubHex[:12], Name: name}
	_ = os.MkdirAll(dir, 0o700)
	b, _ := json.Marshal(id)
	_ = os.WriteFile(path, b, 0o600)
	return id, nil
}

func sharedKey(myPriv []byte, theirPubHex string) ([]byte, error) {
	curve := ecdh.X25519()
	priv, err := curve.NewPrivateKey(myPriv)
	if err != nil {
		return nil, err
	}
	pubBytes, err := hex.DecodeString(theirPubHex)
	if err != nil {
		return nil, err
	}
	pub, err := curve.NewPublicKey(pubBytes)
	if err != nil {
		return nil, err
	}
	secret, err := priv.ECDH(pub)
	if err != nil {
		return nil, err
	}
	return hkdf32(secret, []byte("tract-mesh"), nil), nil
}

// HKDF-SHA256 (RFC 5869), L=32 — matches CryptoKit hkdfDerivedSymmetricKey.
func hkdf32(ikm, salt, info []byte) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	e := hmac.New(sha256.New, salt)
	e.Write(ikm)
	prk := e.Sum(nil)
	x := hmac.New(sha256.New, prk)
	x.Write(info)
	x.Write([]byte{0x01})
	return x.Sum(nil)[:32]
}

func seal(plain string, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := g.Seal(nil, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(append(nonce, ct...)), nil
}

func open(b64 string, key []byte) (string, error) {
	combined, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(combined) < 13 {
		return "", fmt.Errorf("bad box")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	pt, err := g.Open(nil, combined[:12], combined[12:], nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// ---- node HTTP ----

func register(id *identity) {
	postJSON("/peer/register", map[string]any{
		"peerId": peerID, "roomId": room, "userId": id.UserID,
		"displayName": id.Name, "publicKeyHex": id.PubHex, "hideOnline": stealth,
	}, nil)
}

func uploadIdentity(id *identity) {
	blob, _ := json.Marshal(map[string]any{"version": 2, "userId": id.UserID, "publicKeyHex": id.PubHex, "displayName": id.Name})
	postJSON("/identity/store", map[string]any{"userId": id.UserID, "identityBlob": string(blob)}, nil)
}

func fetchIdentity(id string) (pubHex, name string) {
	req, _ := http.NewRequest("GET", nodeURL+"/identity/"+id, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return "", ""
	}
	defer resp.Body.Close()
	var out struct {
		IdentityBlob string `json:"identityBlob"`
	}
	if json.NewDecoder(resp.Body).Decode(&out) != nil || out.IdentityBlob == "" {
		return "", ""
	}
	var blob struct {
		PublicKeyHex string `json:"publicKeyHex"`
		DisplayName  string `json:"displayName"`
	}
	if json.Unmarshal([]byte(out.IdentityBlob), &blob) != nil {
		return "", ""
	}
	return blob.PublicKeyHex, blob.DisplayName
}

func postJSON(path string, body any, out any) error {
	b, _ := json.Marshal(body)
	resp, err := http.Post(nodeURL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func normalizeID(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s != "" && !strings.HasPrefix(s, "@") {
		s = "@" + s
	}
	return s
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

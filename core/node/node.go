// Package node is the embeddable Tract signaling node — the "server" half that
// every device can run inside itself (desktop GUI, CLI, headless). It was lifted
// verbatim out of the old main.go so the same node logic powers `tract-node`, the
// Wails desktop client, and (later, via gomobile) Android — one implementation,
// not three. A process runs a single node, so package-level state is fine.
package node

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tract-signaling/internal/signaling"
	"tract-signaling/internal/storage"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

const PEER_TTL_MS = 15000

var (
	server *signaling.Server
	store  *storage.Storage
)

// Options configures an embedded node.
type Options struct {
	Port    string // listen port; default "8877"
	DataDir string // storage dir; default "./data"
	DistDir string // optional static web dir; "" disables static serving
	Wipe    bool   // erase DataDir before start (one-shot reset)

	// Embedded STUN/TURN relay — makes this node able to relay calls for peers
	// behind NAT/CGNAT (LTE included). Needs a reachable public address.
	TURN       bool   // enable the embedded relay
	TURNPort   string // default "3478"
	PublicHost string // public IP or DDNS hostname; "" = auto-discover via STUN
	TURNUser   string // default "tract"
	TURNSecret string // TURN password; "" = generated and logged

	// Bonjour/mDNS LAN advertisement — nearby devices auto-discover this node.
	Bonjour bool

	// DHT federation — nodes find each other's users via DHTs so users on
	// different nodes reach each other (rendezvous without a central server).
	DHT          bool
	DHTPort      string // private Kademlia UDP listen, default 8878
	DHTBootstrap string // comma-separated UDP addresses of known private DHT nodes
	AdvertiseURL string // override the http URL this node announces in the DHT

	// Mainline DHT — the GLOBAL BitTorrent DHT (BEP-5/44) used as the primary
	// rendezvous. On by default; bootstraps off public routers automatically.
	MainlineOff       bool   // disable joining the global Mainline DHT
	MainlineBootstrap string // extra comma-separated UDP bootstrap addrs (optional)
}

// Start runs the node and blocks until ctx is cancelled, then shuts down
// gracefully. Safe to call from a goroutine (e.g. the desktop app embeds it).
func Start(ctx context.Context, opts Options) error {
	if opts.Port == "" {
		opts.Port = "8877"
	}
	if opts.DataDir == "" {
		opts.DataDir = "./data"
	}

	if opts.Wipe {
		if err := os.RemoveAll(opts.DataDir); err != nil {
			log.Printf("[Tract] WIPE requested but failed: %v", err)
		} else {
			log.Printf("[Tract] data wiped at %s", opts.DataDir)
		}
	}

	if err := os.MkdirAll(opts.DataDir, 0755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}

	var err error
	store, err = storage.New(opts.DataDir)
	if err != nil {
		return fmt.Errorf("init storage: %w", err)
	}
	defer store.Close()

	server = signaling.New(PEER_TTL_MS)
	server.Start()
	defer server.Stop()

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())
	// No gin.Logger() — it would log IPs, paths, and user-agents.

	config := cors.DefaultConfig()
	config.AllowAllOrigins = true
	config.AllowHeaders = []string{"*"}
	router.Use(cors.New(config))

	// Service Worker headers
	router.Use(func(c *gin.Context) {
		if c.Request.URL.Path == "/sw.js" {
			c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
			c.Header("Service-Worker-Allowed", "/")
		}
		if c.Request.URL.Path == "/manifest.webmanifest" {
			c.Header("Content-Type", "application/manifest+json")
		}
		c.Next()
	})

	setupRoutes(router)

	if opts.TURN {
		if err := startTURN(ctx, opts); err != nil {
			log.Printf("[Tract TURN] relay disabled: %v", err)
		}
	}

	if opts.Bonjour {
		startBonjour(ctx, opts.Port)
	}

	if opts.DHT {
		startDHT(ctx, opts)
	}

	if opts.DistDir != "" {
		if _, statErr := os.Stat(opts.DistDir); statErr == nil {
			router.Static("/assets", filepath.Join(opts.DistDir, "assets"))
			router.StaticFile("/manifest.webmanifest", filepath.Join(opts.DistDir, "manifest.webmanifest"))
			router.StaticFile("/sw.js", filepath.Join(opts.DistDir, "sw.js"))
			router.StaticFile("/favicon.ico", filepath.Join(opts.DistDir, "favicon.ico"))
			router.NoRoute(func(c *gin.Context) {
				if c.Request.Method == "GET" {
					c.File(filepath.Join(opts.DistDir, "index.html"))
				} else {
					c.Status(404)
				}
			})
		}
	}

	srv := &http.Server{
		Addr:         "0.0.0.0:" + opts.Port,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		<-ctx.Done()
		log.Println("[Tract] Shutting down gracefully...")
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			log.Printf("Server forced to shutdown: %v", err)
		}
	}()

	log.Printf("[Tract Signaling] listening on http://0.0.0.0:%s", opts.Port)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("serve: %w", err)
	}
	log.Println("[Tract] Server stopped")
	return nil
}

func normalizeUserId(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = strings.ToLower(value)
	if value[0] == '@' {
		return value
	}
	return "@" + value
}

func setupRoutes(router *gin.Engine) {
	router.GET("/health", handleHealth)
	router.GET("/ice", handleIceConfig)
	router.GET("/getstream/config", handleGetStreamConfig)
	router.GET("/getstream/token", handleGetStreamToken)
	router.GET("/events/:peerId", handleSSE)

	router.POST("/peer/register", handlePeerRegister)
	router.POST("/peer/heartbeat", handlePeerHeartbeat)
	router.POST("/peer/unregister", handlePeerUnregister)
	router.GET("/peers/discover", handlePeersDiscover)
	router.GET("/peers/by-user/:userId", handlePeersByUser)
	router.GET("/locate/:userId", handleLocate)

	router.POST("/signal", handleSignal)
	router.GET("/signal/poll/:peerId", handleSignalPoll)

	router.POST("/identity/store", handleIdentityStore)
	router.GET("/identity/:userId", handleIdentityGet)

	router.POST("/inbox/pull", handleInboxPull)
	router.POST("/inbox/ack", handleInboxAck)

	router.POST("/profile/avatar", handleProfileAvatarStore)
	router.GET("/profile/avatar/:userId", handleProfileAvatarGet)
	router.DELETE("/profile/avatar/:userId", handleProfileAvatarDelete)

	router.POST("/contacts/save", handleContactsSave)
	router.GET("/contacts/load/:userId", handleContactsLoad)

	router.POST("/groups/create", handleGroupCreate)
	router.POST("/groups/add-members", handleGroupAddMembers)
	router.GET("/groups/:userId", handleGroupsGetByUser)
	router.POST("/groups/leave", handleGroupLeave)
	router.POST("/groups/delete", handleGroupDelete)
	router.GET("/group/:groupId", handleGroupGet)
	router.POST("/groups/message", handleGroupMessage)
	router.POST("/groups/delete-messages", handleGroupDeleteMessages)
}

// ==================== ICE / TURN ====================

func handleIceConfig(c *gin.Context) {
	urlsRaw := strings.TrimSpace(os.Getenv("TURN_URLS"))
	user := strings.TrimSpace(os.Getenv("TURN_USERNAME"))
	cred := strings.TrimSpace(os.Getenv("TURN_CREDENTIAL"))

	iceServers := []gin.H{}

	// Our own embedded relay (this node, if running TURN): a STUN entry first for
	// direct (server-reflexive) candidates, then the TURN entry as relay fallback.
	if urls, embUser, embPass, ok := relaySnapshot(); ok && len(urls) > 0 {
		stunURLs := make([]string, 0, len(urls))
		for _, u := range urls {
			s := strings.TrimPrefix(u, "turn:")
			if i := strings.IndexByte(s, '?'); i >= 0 {
				s = s[:i]
			}
			stunURLs = append(stunURLs, "stun:"+s)
		}
		iceServers = append(iceServers, gin.H{"urls": stunURLs})
		iceServers = append(iceServers, gin.H{
			"urls":       urls,
			"username":   embUser,
			"credential": embPass,
		})
	}

	if urlsRaw != "" {
		urls := []string{}
		for _, u := range strings.Split(urlsRaw, ",") {
			if t := strings.TrimSpace(u); t != "" {
				urls = append(urls, t)
			}
		}
		if len(urls) > 0 {
			entry := gin.H{"urls": urls}
			if user != "" {
				entry["username"] = user
				entry["credential"] = cred
			}
			iceServers = append(iceServers, entry)
		}
	}

	// Managed public relays (ExpressTURN) as a reliable last resort.
	iceServers = append(iceServers, publicRelayICEServers()...)

	c.JSON(200, gin.H{"iceServers": iceServers})
}

// ==================== HEALTH ====================

func handleHealth(c *gin.Context) {
	c.JSON(200, gin.H{
		"status":     "ok",
		"peers":      server.GetPeerCount(),
		"rooms":      server.GetRoomCount(),
		"identities": len(store.ListIdentities()),
		"timestamp":  time.Now().UnixMilli(),
	})
}

// ==================== SSE ====================

func handleSSE(c *gin.Context) {
	peerId := c.Param("peerId")
	roomId := c.Query("roomId")

	if roomId == "" || peerId == "" {
		c.JSON(400, gin.H{"error": "roomId and peerId required"})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("X-Accel-Buffering", "no")

	c.String(http.StatusOK, ":ok\n\n")
	c.Writer.Flush()

	clientChan := make(chan *signaling.Signal, 256)
	server.RegisterSSEClient(roomId, peerId, clientChan)
	defer server.UnregisterSSEClient(roomId, peerId, clientChan)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	c.Stream(func(w io.Writer) bool {
		select {
		case signal := <-clientChan:
			data, _ := json.Marshal(signal)
			fmt.Fprintf(w, "data: %s\n\n", data)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return true
		case <-ticker.C:
			fmt.Fprintf(w, ":keepalive\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return true
		case <-c.Request.Context().Done():
			return false
		}
	})
}

// ==================== PEER MANAGEMENT ====================

func handlePeerRegister(c *gin.Context) {
	var req struct {
		PeerId       string `json:"peerId"`
		RoomId       string `json:"roomId"`
		UserId       string `json:"userId"`
		DisplayName  string `json:"displayName"`
		DeviceId     string `json:"deviceId"`
		PublicKeyHex string `json:"publicKeyHex"`
		AvatarData   string `json:"avatarData"`
		HideOnline   bool   `json:"hideOnline"`
		LastSeen     *int64 `json:"lastSeen"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if req.PeerId == "" || req.RoomId == "" || req.UserId == "" {
		c.JSON(400, gin.H{"error": "peerId, roomId and userId are required"})
		return
	}

	if req.DisplayName == "" {
		req.DisplayName = req.UserId
	}

	peer := server.AnnouncePeer(req.RoomId, req.PeerId, req.UserId, req.DisplayName, req.AvatarData, req.HideOnline, req.DeviceId)
	server.KickOtherPeers(req.UserId, req.PeerId, req.DeviceId)
	announceUser(req.UserId)
	c.JSON(200, gin.H{"status": "ok"})
	_ = peer
}

func handlePeerHeartbeat(c *gin.Context) {
	var req struct {
		PeerId       string `json:"peerId"`
		RoomId       string `json:"roomId"`
		DisplayName  string `json:"displayName"`
		PublicKeyHex string `json:"publicKeyHex"`
		AvatarData   string `json:"avatarData"`
		HideOnline   bool   `json:"hideOnline"`
		LastSeen     *int64 `json:"lastSeen"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	ok := server.UpdateHeartbeatWithData(req.RoomId, req.PeerId, req.DisplayName, req.PublicKeyHex, req.AvatarData, req.HideOnline, req.LastSeen)
	if !ok {
		c.JSON(404, gin.H{"error": "peer not found"})
		return
	}

	if peerUserId := server.GetPeerUserId(req.RoomId, req.PeerId); peerUserId != "" {
		announceUser(peerUserId)
		normalized := normalizeUserId(peerUserId)
		if storedAvatar, exists := store.GetAvatar(normalized); exists && storedAvatar != "" {
			server.OverridePeerAvatar(req.RoomId, req.PeerId, storedAvatar)
		}
	}

	c.JSON(200, gin.H{"status": "ok"})
}

func handlePeerUnregister(c *gin.Context) {
	var req struct {
		PeerId string `json:"peerId"`
		RoomId string `json:"roomId"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	server.UnregisterPeer(req.RoomId, req.PeerId)
	c.JSON(200, gin.H{"status": "ok"})
}

func handlePeersDiscover(c *gin.Context) {
	roomId := c.Query("roomId")
	peerId := c.Query("peerId")

	peers := server.DiscoverPeers(roomId, peerId)
	c.JSON(200, gin.H{"peers": peers})
}

func handlePeersByUser(c *gin.Context) {
	userId := c.Param("userId")
	roomId := c.Query("roomId")

	peer := server.FindPeerByUserId(roomId, userId)
	c.JSON(200, gin.H{"peer": peer})
}

// handleLocate returns, via the DHT, which node URLs a user is reachable through.
func handleLocate(c *gin.Context) {
	c.JSON(200, gin.H{"nodes": locateUser(c.Param("userId"))})
}

// ==================== SIGNALING ====================

func handleSignal(c *gin.Context) {
	var req struct {
		From     string          `json:"from"`
		To       string          `json:"to"`
		ToUserId string          `json:"toUserId"`
		RoomId   string          `json:"roomId"`
		Type     string          `json:"type"`
		Payload  json.RawMessage `json:"payload"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if req.From == "" || req.RoomId == "" || req.Type == "" {
		c.JSON(400, gin.H{"error": "from, roomId and type are required"})
		return
	}

	persisted := false

	if req.Payload != nil {
		var payloadMap map[string]interface{}
		if err := json.Unmarshal(req.Payload, &payloadMap); err == nil {
			if ptype, ok := payloadMap["type"].(string); ok && ptype == "message_control" {
				recipientUserId := normalizeUserId(req.ToUserId)
				if recipientUserId != "" {
					if action, ok := payloadMap["action"].(string); ok {
						switch action {
						case "delete_messages":
							if packetIds, ok := payloadMap["packetIds"].([]interface{}); ok {
								idSet := make([]string, 0)
								for _, pid := range packetIds {
									if s, ok := pid.(string); ok {
										idSet = append(idSet, s)
									}
								}
								if len(idSet) > 0 {
									store.RemoveInboxEntries(recipientUserId, func(entry *storage.InboxEntry) bool {
										if entry.Payload != nil {
											if pid, ok := entry.Payload["packetId"].(string); ok {
												for _, target := range idSet {
													if pid == target {
														return true
													}
												}
											}
										}
										return false
									})
								}
							}
						case "clear_chat":
							fromUserId := ""
							if s, ok := payloadMap["senderId"].(string); ok {
								fromUserId = s
							}
							if fromUserId != "" {
								store.RemoveInboxEntries(recipientUserId, func(entry *storage.InboxEntry) bool {
									return entry.FromUserId == fromUserId
								})
							}
						}
					}
				}
			}

			if payloadMap != nil && req.Type == "app_packet" {
				if ptype, ok := payloadMap["type"].(string); ok && (ptype == "text" || ptype == "message_control" || ptype == "call") && req.ToUserId != "" {
					recipientUserId := normalizeUserId(req.ToUserId)
					if recipientUserId != "" {
						fromUserId := ""
						if s, ok := payloadMap["senderId"].(string); ok {
							fromUserId = s
						}
						store.EnqueueAppPacket(recipientUserId, req.From, fromUserId, payloadMap)
						persisted = true
					}
				}
			}
		}
	}

	targetPeerId := req.To
	if targetPeerId == "" && req.ToUserId != "" {
		peer := server.FindPeerByUserId(req.RoomId, req.ToUserId)
		if peer != nil {
			targetPeerId = peer.PeerId
		}
	}

	if targetPeerId != "" {
		signal := &signaling.Signal{
			From:    req.From,
			Type:    req.Type,
			Payload: req.Payload,
		}
		server.SendSignal(req.RoomId, targetPeerId, signal)
	} else if req.ToUserId != "" && c.GetHeader("X-Tract-Forwarded") == "" {
		// Recipient isn't on this node — federate via DHT to the node holding them.
		if fwd, err := json.Marshal(gin.H{
			"from": req.From, "to": req.To, "toUserId": req.ToUserId,
			"roomId": req.RoomId, "type": req.Type, "payload": req.Payload,
		}); err == nil {
			for _, nodeURL := range locateUser(req.ToUserId) {
				if nodeURL != selfURL {
					go forwardSignal(nodeURL, fwd)
				}
			}
		}
	}

	c.JSON(200, gin.H{"status": "queued", "persisted": persisted})
}

func handleSignalPoll(c *gin.Context) {
	peerId := c.Param("peerId")
	roomId := c.Query("roomId")

	signals := server.PollSignals(roomId, peerId)
	c.JSON(200, gin.H{"messages": signals})
}

// ==================== IDENTITY ====================

func handleIdentityStore(c *gin.Context) {
	var req struct {
		UserId       string `json:"userId"`
		IdentityBlob string `json:"identityBlob"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	normalized := normalizeUserId(req.UserId)
	if normalized == "" {
		c.JSON(400, gin.H{"error": "invalid userId"})
		return
	}

	if err := store.StoreIdentity(normalized, req.IdentityBlob); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"status": "ok"})
}

func handleIdentityGet(c *gin.Context) {
	userId := c.Param("userId")
	normalized := normalizeUserId(userId)

	blob, updatedAt, ok := store.GetIdentity(normalized)
	if !ok {
		c.JSON(404, gin.H{"error": "identity not found"})
		return
	}

	c.JSON(200, gin.H{"identityBlob": blob, "updatedAt": updatedAt})
}

// ==================== INBOX ====================

func handleInboxPull(c *gin.Context) {
	var req struct {
		UserId string `json:"userId"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	normalized := normalizeUserId(req.UserId)
	if normalized == "" {
		c.JSON(400, gin.H{"error": "userId is required"})
		return
	}

	entries, err := store.GetInbox(normalized)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"messages": entries})
}

func handleInboxAck(c *gin.Context) {
	var req struct {
		UserId string   `json:"userId"`
		Ids    []string `json:"ids"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	normalized := normalizeUserId(req.UserId)
	if normalized == "" {
		c.JSON(400, gin.H{"error": "userId is required"})
		return
	}

	if err := store.AckInboxMessages(normalized, req.Ids); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"status": "ok", "removed": len(req.Ids)})
}

// ==================== PROFILE / AVATARS ====================

func handleProfileAvatarStore(c *gin.Context) {
	var req struct {
		UserId         string `json:"userId"`
		AvatarData     string `json:"avatarData"`
		AvatarOriginal string `json:"avatarOriginal"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if req.UserId == "" || req.AvatarData == "" {
		c.JSON(400, gin.H{"error": "userId and avatarData are required"})
		return
	}

	normalized := normalizeUserId(req.UserId)
	cleaned := stripImageMetadata(req.AvatarData)

	if err := store.StoreAvatar(normalized, cleaned, req.AvatarOriginal); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	server.UpdatePeersAvatar(normalized, cleaned)
	server.SendToUserPeers(normalized, &signaling.Signal{Type: "avatar-changed"})

	c.JSON(200, gin.H{"status": "ok", "avatarData": cleaned})
}

var avatarCache sync.Map

func handleProfileAvatarGet(c *gin.Context) {
	userId := c.Param("userId")
	normalized := normalizeUserId(userId)

	data, ok := store.GetAvatar(normalized)
	if !ok || data == "" {
		c.JSON(404, gin.H{"avatarData": nil})
		return
	}

	original, _ := store.GetAvatarOriginal(normalized)

	c.JSON(200, gin.H{"avatarData": data, "avatarOriginal": original})
}

func handleProfileAvatarDelete(c *gin.Context) {
	userId := c.Param("userId")
	normalized := normalizeUserId(userId)

	if err := store.DeleteAvatar(normalized); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	server.UpdatePeersAvatar(normalized, "")
	server.SendToUserPeers(normalized, &signaling.Signal{Type: "avatar-changed"})

	c.JSON(200, gin.H{"status": "ok"})
}

// ==================== CONTACTS ====================

func handleContactsSave(c *gin.Context) {
	var req struct {
		UserId   string                   `json:"userId"`
		Contacts []map[string]interface{} `json:"contacts"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if req.UserId == "" {
		c.JSON(400, gin.H{"error": "userId is required"})
		return
	}

	if err := store.SaveContacts(req.UserId, req.Contacts); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"status": "ok", "count": len(req.Contacts)})
}

func handleContactsLoad(c *gin.Context) {
	userId := c.Param("userId")

	contacts, err := store.GetContacts(userId)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"contacts": contacts})
}

// ==================== GROUPS ====================

func handleGroupCreate(c *gin.Context) {
	var req struct {
		GroupId    string                   `json:"groupId"`
		Name       string                   `json:"name"`
		AvatarData string                   `json:"avatarData"`
		CreatedBy  string                   `json:"createdBy"`
		Members    []map[string]interface{} `json:"members"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if req.GroupId == "" || req.CreatedBy == "" {
		c.JSON(400, gin.H{"error": "groupId and createdBy are required"})
		return
	}

	if req.Name == "" {
		req.Name = "Unnamed Group"
	}

	memberList := req.Members
	if memberList == nil {
		memberList = make([]map[string]interface{}, 0)
	}

	hasCreator := false
	for _, m := range memberList {
		if uid, ok := m["userId"].(string); ok && uid == req.CreatedBy {
			hasCreator = true
			break
		}
	}
	if !hasCreator {
		memberList = append(memberList, map[string]interface{}{
			"userId":  req.CreatedBy,
			"role":    "admin",
			"addedAt": time.Now().UnixMilli(),
		})
	}

	group := &storage.GroupRecord{
		GroupId:    req.GroupId,
		Name:       req.Name,
		AvatarData: req.AvatarData,
		CreatedBy:  req.CreatedBy,
		Members:    memberList,
		CreatedAt:  time.Now().UnixMilli(),
	}

	if err := store.CreateGroup(group); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	for _, member := range memberList {
		if uid, ok := member["userId"].(string); ok {
			store.EnqueueInboxMessage(uid, map[string]interface{}{
				"type":      "group_event",
				"action":    "created",
				"groupId":   req.GroupId,
				"name":      group.Name,
				"createdBy": req.CreatedBy,
			})
		}
	}

	c.JSON(200, gin.H{"status": "ok", "group": group})
}

func handleGroupAddMembers(c *gin.Context) {
	var req struct {
		GroupId string                   `json:"groupId"`
		Members []map[string]interface{} `json:"members"`
		AddedBy string                   `json:"addedBy"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	group, err := store.AddGroupMembers(req.GroupId, req.Members)
	if err != nil {
		if err == os.ErrNotExist {
			c.JSON(404, gin.H{"error": "group not found"})
		} else {
			c.JSON(500, gin.H{"error": err.Error()})
		}
		return
	}

	added := make([]string, 0)
	existing := make(map[string]bool)
	for _, m := range group.Members {
		if uid, ok := m["userId"].(string); ok {
			existing[uid] = true
		}
	}
	for _, m := range req.Members {
		if uid, ok := m["userId"].(string); ok && !existing[uid] {
			added = append(added, uid)
			existing[uid] = true
		}
	}

	c.JSON(200, gin.H{"status": "ok", "added": added, "group": group})
}

func handleGroupsGetByUser(c *gin.Context) {
	userId := c.Param("userId")

	groups, err := store.GetUserGroups(userId)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"groups": groups})
}

func handleGroupLeave(c *gin.Context) {
	var req struct {
		GroupId string `json:"groupId"`
		UserId  string `json:"userId"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	deleted, err := store.LeaveGroup(req.GroupId, req.UserId)
	if err != nil {
		if err == os.ErrNotExist {
			c.JSON(404, gin.H{"error": "group not found"})
		} else {
			c.JSON(500, gin.H{"error": err.Error()})
		}
		return
	}

	if !deleted {
		group, _ := store.GetGroup(req.GroupId)
		if group != nil {
			for _, member := range group.Members {
				if uid, ok := member["userId"].(string); ok {
					store.EnqueueInboxMessage(uid, map[string]interface{}{
						"type":    "group_event",
						"action":  "member_left",
						"groupId": req.GroupId,
						"userId":  req.UserId,
					})
				}
			}
		}
	}

	c.JSON(200, gin.H{"status": "ok", "deleted": deleted})
}

func handleGroupDelete(c *gin.Context) {
	var req struct {
		GroupId string `json:"groupId"`
		UserId  string `json:"userId"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	group, err := store.GetGroup(req.GroupId)
	if err != nil {
		c.JSON(404, gin.H{"error": "group not found"})
		return
	}

	if err := store.DeleteGroup(req.GroupId, req.UserId); err != nil {
		if err == os.ErrPermission {
			c.JSON(403, gin.H{"error": "only admins can delete the group"})
		} else if err == os.ErrNotExist {
			c.JSON(404, gin.H{"error": "group not found"})
		} else {
			c.JSON(500, gin.H{"error": err.Error()})
		}
		return
	}

	memberIds := make([]string, 0)
	for _, m := range group.Members {
		if uid, ok := m["userId"].(string); ok {
			memberIds = append(memberIds, uid)
			store.RemoveInboxEntries(uid, func(entry *storage.InboxEntry) bool {
				return entry.GroupId == req.GroupId || (entry.Payload != nil && entry.Payload["groupId"] == req.GroupId)
			})
		}
	}

	for _, memberId := range memberIds {
		store.EnqueueInboxMessage(memberId, map[string]interface{}{
			"type":      "group_event",
			"action":    "deleted",
			"groupId":   req.GroupId,
			"deletedBy": req.UserId,
		})
	}

	c.JSON(200, gin.H{"status": "ok"})
}

func handleGroupGet(c *gin.Context) {
	groupId := c.Param("groupId")

	group, err := store.GetGroup(groupId)
	if err != nil {
		c.JSON(404, gin.H{"error": "group not found"})
		return
	}

	c.JSON(200, gin.H{"group": group})
}

func handleGroupMessage(c *gin.Context) {
	var req struct {
		GroupId    string                 `json:"groupId"`
		FromUserId string                 `json:"fromUserId"`
		Packet     map[string]interface{} `json:"packet"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if req.GroupId == "" || req.Packet == nil {
		c.JSON(400, gin.H{"error": "groupId and packet are required"})
		return
	}

	deliveredCount, messageId, err := store.SendGroupMessage(req.GroupId, req.FromUserId, req.Packet)
	if err != nil {
		if err == os.ErrNotExist {
			c.JSON(404, gin.H{"error": "group not found"})
		} else {
			c.JSON(500, gin.H{"error": err.Error()})
		}
		return
	}

	if deliveredCount == 0 {
		c.JSON(400, gin.H{"error": "No group recipients could be encrypted"})
		return
	}

	c.JSON(200, gin.H{"status": "ok", "messageId": messageId, "deliveredCount": deliveredCount})
}

func handleGroupDeleteMessages(c *gin.Context) {
	var req struct {
		GroupId   string   `json:"groupId"`
		UserId    string   `json:"userId"`
		PacketIds []string `json:"packetIds"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if req.GroupId == "" || len(req.PacketIds) == 0 {
		c.JSON(400, gin.H{"error": "groupId and packetIds array are required"})
		return
	}

	removed, err := store.DeleteGroupMessages(req.GroupId, req.UserId, req.PacketIds)
	if err != nil {
		if err == os.ErrNotExist {
			c.JSON(404, gin.H{"error": "group not found"})
		} else {
			c.JSON(500, gin.H{"error": err.Error()})
		}
		return
	}

	group, _ := store.GetGroup(req.GroupId)
	if group != nil {
		for _, member := range group.Members {
			if uid, ok := member["userId"].(string); ok {
				store.EnqueueInboxMessage(uid, map[string]interface{}{
					"type":        "message_control",
					"action":      "delete_messages",
					"packetIds":   req.PacketIds,
					"senderId":    req.UserId,
					"recipientId": req.GroupId,
				})
			}
		}
	}

	c.JSON(200, gin.H{"status": "ok", "removed": removed})
}

func generateID() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 32)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		b[i] = charset[n.Int64()]
	}
	return string(b)
}

// stripImageMetadata re-encodes an image data URL as PNG, dropping EXIF/metadata.
func stripImageMetadata(dataURL string) string {
	comma := strings.Index(dataURL, ",")
	if comma < 0 {
		return dataURL
	}
	b64data := dataURL[comma+1:]

	decoded, err := base64.StdEncoding.DecodeString(b64data)
	if err != nil {
		return dataURL
	}

	img, _, err := image.Decode(bytes.NewReader(decoded))
	if err != nil {
		return dataURL
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return dataURL
	}

	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

package main

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
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"tract-signaling/internal/signaling"
	"tract-signaling/internal/storage"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

const (
	SUPERUSER_ID = "@creator"
	PEER_TTL_MS  = 15000
)

var (
	server *signaling.Server
	store  *storage.Storage
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8877"
	}

	dataDir := "./data"
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	var err error
	store, err = storage.New(dataDir)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	defer store.Close()

	server = signaling.New(PEER_TTL_MS)
	server.Start()
	defer server.Stop()

	bootstrapAdminInvite()

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())
	router.Use(gin.Logger())

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

	distDir := "./dist"
	if _, err := os.Stat(distDir); err == nil {
		router.Static("/assets", filepath.Join(distDir, "assets"))
		router.StaticFile("/manifest.webmanifest", filepath.Join(distDir, "manifest.webmanifest"))
		router.StaticFile("/sw.js", filepath.Join(distDir, "sw.js"))
		router.StaticFile("/favicon.ico", filepath.Join(distDir, "favicon.ico"))
		router.NoRoute(func(c *gin.Context) {
			if c.Request.Method == "GET" {
				c.File(filepath.Join(distDir, "index.html"))
			} else {
				c.Status(404)
			}
		})
	}

	srv := &http.Server{
		Addr:         "0.0.0.0:" + port,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		sigint := make(chan os.Signal, 1)
		signal.Notify(sigint, os.Interrupt, syscall.SIGTERM)
		<-sigint

		log.Println("[Tract] Shutting down gracefully...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("Server forced to shutdown: %v", err)
		}
	}()

	log.Printf("[Tract Signaling] listening on http://0.0.0.0:%s", port)
	log.Printf("[Tract] Static (if built): %s", distDir)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server failed: %v", err)
	}

	log.Println("[Tract] Server stopped")
}

func bootstrapAdminInvite() {
	invites, _ := store.LoadInvites()
	if invites == nil {
		invites = make(map[string]*storage.InviteRecord)
	}

	const bootstrapMarker = "__bootstrap__"

	// Check if bootstrap invite exists and is still unused
	if marker, exists := invites[bootstrapMarker]; exists && marker.UsedBy != "" {
		code := marker.UsedBy
		if inv, ok := invites[code]; ok && inv.UsedBy == "" {
			fmt.Printf("\n  === ADMIN BOOTSTRAP INVITE ===\n")
			fmt.Printf("  URL: ?invite=%s\n", code)
			fmt.Printf("  ==============================\n\n")
			return
		}
	}

	// Create fresh bootstrap invite
	code := fmt.Sprintf("inv-%s", generateShortID())
	invites[code] = &storage.InviteRecord{
		UsedBy:    "",
		CreatedBy: "system",
		CreatedAt: time.Now().UnixMilli(),
	}
	invites[bootstrapMarker] = &storage.InviteRecord{
		UsedBy:    code,
		CreatedBy: "system",
		CreatedAt: time.Now().UnixMilli(),
	}
	store.SaveInvites(invites)

	fmt.Printf("\n  === ADMIN BOOTSTRAP INVITE ===\n")
	fmt.Printf("  Register the superuser at: %s\n", code)
	fmt.Printf("  URL: ?invite=%s\n", code)
	fmt.Printf("  ==============================\n\n")
}

func generateShortID() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		b[i] = charset[n.Int64()]
	}
	return string(b)
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
	// Health
	router.GET("/health", handleHealth)

	// SSE - matches JS /events/:peerId?roomId=...
	router.GET("/events/:peerId", handleSSE)

	// Peer management
	router.POST("/peer/register", handlePeerRegister)
	router.POST("/peer/heartbeat", handlePeerHeartbeat)
	router.POST("/peer/unregister", handlePeerUnregister)
	router.GET("/peers/discover", handlePeersDiscover)
	router.GET("/peers/by-user/:userId", handlePeersByUser)

	// Signaling
	router.POST("/signal", handleSignal)
	router.GET("/signal/poll/:peerId", handleSignalPoll)

	// Identity
	router.POST("/identity/store", handleIdentityStore)
	router.GET("/identity/:userId", handleIdentityGet)

	// Inbox (matches JS /inbox/pull POST, /inbox/ack POST)
	router.POST("/inbox/pull", handleInboxPull)
	router.POST("/inbox/ack", handleInboxAck)

	// Profile / Avatars
	router.POST("/profile/avatar", handleProfileAvatarStore)
	router.GET("/profile/avatar/:userId", handleProfileAvatarGet)

	// Contacts
	router.POST("/contacts/save", handleContactsSave)
	router.GET("/contacts/load/:userId", handleContactsLoad)

	// Groups
	router.POST("/groups/create", handleGroupCreate)
	router.POST("/groups/add-members", handleGroupAddMembers)
	router.GET("/groups/:userId", handleGroupsGetByUser)
	router.POST("/groups/leave", handleGroupLeave)
	router.POST("/groups/delete", handleGroupDelete)
	router.GET("/group/:groupId", handleGroupGet)
	router.POST("/groups/message", handleGroupMessage)
	router.POST("/groups/delete-messages", handleGroupDeleteMessages)

	// Admin
	router.POST("/admin/users", handleAdminUsers)
	router.POST("/admin/ban", handleAdminBan)
	router.POST("/admin/unban", handleAdminUnban)
	router.GET("/admin/check-banned/:userId", handleAdminCheckBanned)
	router.POST("/admin/invite/create", handleAdminInviteCreate)
	router.POST("/admin/invite/use", handleAdminInviteUse)
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
		PeerId      string `json:"peerId"`
		RoomId      string `json:"roomId"`
		UserId      string `json:"userId"`
		DisplayName string `json:"displayName"`
		PublicKeyHex string `json:"publicKeyHex"`
		AvatarData  string `json:"avatarData"`
		HideOnline  bool   `json:"hideOnline"`
		LastSeen    *int64 `json:"lastSeen"`
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

	normalized := normalizeUserId(req.UserId)
	if store.IsBanned(normalized) {
		c.JSON(403, gin.H{"error": "user is banned"})
		return
	}

	peer := server.AnnouncePeer(req.RoomId, req.PeerId, req.UserId, req.DisplayName, req.AvatarData, req.HideOnline)
	c.JSON(200, gin.H{"status": "ok"})
	_ = peer
}

func handlePeerHeartbeat(c *gin.Context) {
	var req struct {
		PeerId      string `json:"peerId"`
		RoomId      string `json:"roomId"`
		DisplayName string `json:"displayName"`
		PublicKeyHex string `json:"publicKeyHex"`
		AvatarData  string `json:"avatarData"`
		HideOnline  bool   `json:"hideOnline"`
		LastSeen    *int64 `json:"lastSeen"`
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

	// Override peer avatar with server-stored avatar for cross-device sync
	if peerUserId := server.GetPeerUserId(req.RoomId, req.PeerId); peerUserId != "" {
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

	// Handle inbox operations for message_control
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
		}

		// Persist app_packet to inbox (must match JS: outer type === 'app_packet')
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

	// Forward signal to target peer via SSE or poll queue
	targetPeerId := req.To
	if targetPeerId == "" && req.ToUserId != "" {
		// Look up online peer for this user
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

	if store.IsBanned(normalized) {
		c.JSON(403, gin.H{"error": "user is banned"})
		return
	}

	if err := store.StoreIdentity(normalized, req.IdentityBlob); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[Identity] Stored for %s", normalized)
	c.JSON(200, gin.H{"status": "ok"})
}

func handleIdentityGet(c *gin.Context) {
	userId := c.Param("userId")
	normalized := normalizeUserId(userId)

	if store.IsBanned(normalized) {
		c.JSON(403, gin.H{"error": "user is banned"})
		return
	}

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

	c.JSON(200, gin.H{
		"messages": entries,
	})
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
		UserId          string `json:"userId"`
		AvatarData      string `json:"avatarData"`
		AvatarOriginal  string `json:"avatarOriginal"`
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

	// Strip EXIF/metadata from uploaded image by re-encoding as PNG
	cleaned := stripImageMetadata(req.AvatarData)

	if err := store.StoreAvatar(normalized, cleaned, req.AvatarOriginal); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Update all connected peers for this userId with the new avatar
	server.UpdatePeersAvatar(normalized, cleaned)

	// Notify all devices of this user that their avatar changed (SSE)
	server.SendToUserPeers(normalized, &signaling.Signal{
		Type: "avatar-changed",
	})

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
		GroupId   string                   `json:"groupId"`
		Name      string                   `json:"name"`
		AvatarData string                  `json:"avatarData"`
		CreatedBy string                   `json:"createdBy"`
		Members   []map[string]interface{} `json:"members"`
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

	// Notify all members (including creator, matching JS behavior)
	for _, member := range memberList {
		if uid, ok := member["userId"].(string); ok {
			store.EnqueueInboxMessage(uid, map[string]interface{}{
				"type":    "group_event",
				"action":  "created",
				"groupId": req.GroupId,
				"name":    group.Name,
				"createdBy": req.CreatedBy,
			})
		}
	}

	log.Printf("[Groups] Created %s by %s", req.GroupId, req.CreatedBy)
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

	// Only include members that were actually added (not already present)
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

	// Notify remaining members if group wasn't deleted
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

	log.Printf("[Groups] %s left group %s (deleted=%v)", req.UserId, req.GroupId, deleted)
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

	// Get group members before delete
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

	// Clean up inbox messages for group members only (matching JS behavior)
	memberIds := make([]string, 0)
	for _, m := range group.Members {
		if uid, ok := m["userId"].(string); ok {
			memberIds = append(memberIds, uid)
			store.RemoveInboxEntries(uid, func(entry *storage.InboxEntry) bool {
				return entry.GroupId == req.GroupId || (entry.Payload != nil && entry.Payload["groupId"] == req.GroupId)
			})
		}
	}

	// Notify all members (including requester, matching JS behavior)
	for _, memberId := range memberIds {
		store.EnqueueInboxMessage(memberId, map[string]interface{}{
			"type":      "group_event",
			"action":    "deleted",
			"groupId":   req.GroupId,
			"deletedBy": req.UserId,
		})
	}

	log.Printf("[Groups] Deleted %s by %s", req.GroupId, req.UserId)
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

	// Notify all members with deletion signal (including requester, matching JS)
	group, _ := store.GetGroup(req.GroupId)
	if group != nil {
		for _, member := range group.Members {
			if uid, ok := member["userId"].(string); ok {
				store.EnqueueInboxMessage(uid, map[string]interface{}{
					"type":      "message_control",
					"action":    "delete_messages",
					"packetIds": req.PacketIds,
					"senderId":  req.UserId,
					"recipientId": req.GroupId,
				})
			}
		}
	}

	c.JSON(200, gin.H{"status": "ok", "removed": removed})
}

// ==================== ADMIN ====================

func requireSuperuser(c *gin.Context) bool {
	var req struct {
		UserId string `json:"userId"`
	}
	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return false
	}
	if normalizeUserId(req.UserId) != SUPERUSER_ID {
		c.JSON(403, gin.H{"error": "forbidden"})
		return false
	}
	return true
}

func handleAdminUsers(c *gin.Context) {
	if !requireSuperuser(c) {
		return
	}

	identities := store.ListIdentities()
	userList := make([]gin.H, 0)

	for userId, rec := range identities {
		displayName := ""
		if rec.Blob != "" {
			var blobMap map[string]interface{}
			if err := json.Unmarshal([]byte(rec.Blob), &blobMap); err == nil {
				if dn, ok := blobMap["displayName"].(string); ok {
					displayName = dn
				}
			}
		}

		hasAvatar := store.GetAvatarForAdmin(userId) != ""
		online := server.IsUserOnline(userId)

		userList = append(userList, gin.H{
			"userId":    userId,
			"displayName": displayName,
			"hasAvatar": hasAvatar,
			"online":    online,
			"banned":    store.IsBanned(userId),
		})
	}

	// Sort by userId
	for i := 0; i < len(userList); i++ {
		for j := i + 1; j < len(userList); j++ {
			if userList[i]["userId"].(string) > userList[j]["userId"].(string) {
				userList[i], userList[j] = userList[j], userList[i]
			}
		}
	}

	c.JSON(200, gin.H{"users": userList})
}

func handleAdminBan(c *gin.Context) {
	var req struct {
		UserId      string `json:"userId"`
		TargetUserId string `json:"targetUserId"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if normalizeUserId(req.UserId) != SUPERUSER_ID {
		c.JSON(403, gin.H{"error": "admin only"})
		return
	}

	normalized := normalizeUserId(req.TargetUserId)
	if normalized == "" || normalized == SUPERUSER_ID {
		c.JSON(400, gin.H{"error": "cannot ban superuser"})
		return
	}

	if err := store.BanUser(normalized); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Also disconnect the user's peers if they're online
	// (the ban check on peer/register prevents reconnection)

	log.Printf("[Admin] Banned %s", normalized)
	c.JSON(200, gin.H{"status": "ok", "banned": normalized})
}

func handleAdminUnban(c *gin.Context) {
	var req struct {
		UserId        string `json:"userId"`
		TargetUserId string `json:"targetUserId"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if normalizeUserId(req.UserId) != SUPERUSER_ID {
		c.JSON(403, gin.H{"error": "admin only"})
		return
	}

	normalized := normalizeUserId(req.TargetUserId)
	if err := store.UnbanUser(normalized); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[Admin] Unbanned %s", normalized)
	c.JSON(200, gin.H{"status": "ok", "unbanned": normalized})
}

func handleAdminCheckBanned(c *gin.Context) {
	userId := c.Param("userId")
	normalized := normalizeUserId(userId)

	banned := false
	if normalized != "" {
		banned = store.IsBanned(normalized)
	}

	c.JSON(200, gin.H{"banned": banned})
}

func handleAdminInviteCreate(c *gin.Context) {
	var req struct {
		UserId string `json:"userId"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if normalizeUserId(req.UserId) != SUPERUSER_ID {
		c.JSON(403, gin.H{"error": "admin only"})
		return
	}

	code := fmt.Sprintf("inv-%s", generateShortID())
	invite := &storage.InviteRecord{
		UsedBy:    "",
		CreatedBy: req.UserId,
		CreatedAt: time.Now().UnixMilli(),
	}

	if err := store.CreateInvite(code, invite); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[Admin] Created invite code %s", code)
	c.JSON(200, gin.H{"status": "ok", "code": code})
}

func handleAdminInviteUse(c *gin.Context) {
	var req struct {
		Code   string `json:"code"`
		UserId string `json:"userId"`
	}

	if err := c.BindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request"})
		return
	}

	if req.Code == "" || req.UserId == "" {
		c.JSON(400, gin.H{"error": "code and userId required"})
		return
	}

	normalized := normalizeUserId(req.UserId)
	if normalized == "" {
		c.JSON(400, gin.H{"error": "invalid userId"})
		return
	}

	if err := store.UseInvite(req.Code, normalized); err != nil {
		if err == os.ErrNotExist {
			c.JSON(404, gin.H{"error": "invite code not found"})
		} else if err == os.ErrExist {
			c.JSON(400, gin.H{"error": "invite code already used"})
		} else {
			c.JSON(500, gin.H{"error": err.Error()})
		}
		return
	}

	log.Printf("[Admin] Invite code %s used by %s", req.Code, normalized)
	c.JSON(200, gin.H{"status": "ok"})
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

// stripImageMetadata decodes an image from a data URL and re-encodes as PNG,
// stripping all EXIF and other metadata in the process.
// Returns the original data URL if decoding fails.
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

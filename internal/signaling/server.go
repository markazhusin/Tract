package signaling

import (
	"encoding/json"
	"sync"
	"time"
)

type Peer struct {
	PeerId      string `json:"peerId"`
	RoomId      string `json:"roomId"`
	UserId      string `json:"userId"`
	DisplayName string `json:"displayName"`
	PublicKey   string `json:"publicKey,omitempty"`
	Avatar      string `json:"avatar,omitempty"`
	HideOnline  bool   `json:"hideOnline"`
	LastSeen    *int64 `json:"lastSeen,omitempty"`
	Address     string `json:"-"`
	Timestamp   int64  `json:"timestamp"`
}

type Signal struct {
	From    string          `json:"from"`
	To      string          `json:"to,omitempty"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type Server struct {
	mu         sync.RWMutex
	peers      map[string]*Peer
	signals    map[string][]*Signal
	sseClients map[string]map[chan<- *Signal]bool
	peerTTL    time.Duration
	stopCh     chan struct{}
}

func New(peerTTLMs int64) *Server {
	s := &Server{
		peers:      make(map[string]*Peer),
		signals:    make(map[string][]*Signal),
		sseClients: make(map[string]map[chan<- *Signal]bool),
		peerTTL:    time.Duration(peerTTLMs) * time.Millisecond,
		stopCh:     make(chan struct{}),
	}
	return s
}

func (s *Server) Start() {
	go s.cleanupLoop()
}

func (s *Server) Stop() {
	close(s.stopCh)
}

func peerKey(roomId, peerId string) string {
	return roomId + ":" + peerId
}

func (s *Server) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.cleanupExpired()
		case <-s.stopCh:
			return
		}
	}
}

func (s *Server) cleanupExpired() {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UnixMilli()
	for key, peer := range s.peers {
		if now-peer.Timestamp > int64(s.peerTTL.Milliseconds()) {
			delete(s.peers, key)
			delete(s.signals, key)
		}
	}
}

// ==================== PEER MANAGEMENT ====================

func (s *Server) AnnouncePeer(roomId, peerId, userId, displayName, avatar string, hideOnline bool) *Peer {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := peerKey(roomId, peerId)
	var lastSeen *int64
	if !hideOnline {
		t := time.Now().UnixMilli()
		lastSeen = &t
	}

	peer := &Peer{
		PeerId:      peerId,
		RoomId:      roomId,
		UserId:      userId,
		DisplayName: displayName,
		Avatar:      avatar,
		HideOnline:  hideOnline,
		LastSeen:    lastSeen,
		Timestamp:   time.Now().UnixMilli(),
	}
	s.peers[key] = peer
	if s.signals[key] == nil {
		s.signals[key] = make([]*Signal, 0)
	}
	return peer
}

func (s *Server) UpdateHeartbeat(roomId, peerId string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := peerKey(roomId, peerId)
	peer, ok := s.peers[key]
	if !ok {
		return false
	}
	peer.Timestamp = time.Now().UnixMilli()
	return true
}

func (s *Server) UpdateHeartbeatWithData(roomId, peerId, displayName, publicKeyHex, avatarData string, hideOnline bool, lastSeen *int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := peerKey(roomId, peerId)
	peer, ok := s.peers[key]
	if !ok {
		return false
	}
	peer.Timestamp = time.Now().UnixMilli()
	if displayName != "" {
		peer.DisplayName = displayName
	}
	if publicKeyHex != "" {
		peer.PublicKey = publicKeyHex
	}
	if avatarData != "" {
		peer.Avatar = avatarData
	}
	peer.HideOnline = hideOnline
	if hideOnline {
		peer.LastSeen = nil
	} else if lastSeen != nil {
		peer.LastSeen = lastSeen
	}
	return true
}

func (s *Server) UnregisterPeer(roomId, peerId string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := peerKey(roomId, peerId)
	delete(s.peers, key)
	delete(s.signals, key)
}

func (s *Server) ListPeers(roomId string) []*Peer {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]*Peer, 0)
	for _, peer := range s.peers {
		if peer.RoomId == roomId {
			result = append(result, peer)
		}
	}
	return result
}

func (s *Server) DiscoverPeers(roomId, excludePeerId string) []*Peer {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]*Peer, 0)
	for _, peer := range s.peers {
		if peer.RoomId == roomId && peer.PeerId != excludePeerId {
			result = append(result, peer)
		}
	}
	return result
}

func (s *Server) FindPeerByUserId(roomId, userId string) *Peer {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, peer := range s.peers {
		if peer.RoomId == roomId && peer.UserId == userId {
			return peer
		}
	}
	return nil
}

// ==================== SIGNALING ====================

func (s *Server) EnqueueSignal(key string, signal *Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.signals[key] == nil {
		s.signals[key] = make([]*Signal, 0)
	}
	s.signals[key] = append(s.signals[key], signal)
}

func (s *Server) PollSignals(roomId, peerId string) []*Signal {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := peerKey(roomId, peerId)
	signals := s.signals[key]
	s.signals[key] = make([]*Signal, 0)
	return signals
}

func (s *Server) SendSignal(roomId, toPeerId string, signal *Signal) error {
	key := peerKey(roomId, toPeerId)

	// Try SSE first (non-blocking, but if channel is full, fall back to poll queue instead of dropping)
	s.mu.RLock()
	clients, hasSSE := s.sseClients[key]
	s.mu.RUnlock()

	if hasSSE && len(clients) > 0 {
		delivered := false
		for ch := range clients {
			select {
			case ch <- signal:
				delivered = true
			default:
			}
		}
		if delivered {
			return nil
		}
	}

	// Fall back to poll queue (also used if SSE channel was full)
	s.EnqueueSignal(key, signal)
	return nil
}

// ==================== SSE ====================

func (s *Server) RegisterSSEClient(roomId, peerId string, ch chan<- *Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := peerKey(roomId, peerId)
	if s.sseClients[key] == nil {
		s.sseClients[key] = make(map[chan<- *Signal]bool)
	}
	s.sseClients[key][ch] = true
}

func (s *Server) UnregisterSSEClient(roomId, peerId string, ch chan<- *Signal) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := peerKey(roomId, peerId)
	if clients, ok := s.sseClients[key]; ok {
		delete(clients, ch)
		if len(clients) == 0 {
			delete(s.sseClients, key)
		}
	}
}

// ==================== HELPERS ====================

// UpdatePeersAvatar updates the Avatar field on ALL connected peers for a given userId.
func (s *Server) UpdatePeersAvatar(userId, avatar string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, peer := range s.peers {
		if peer.UserId == userId {
			peer.Avatar = avatar
		}
	}
}

// OverridePeerAvatar sets the Avatar field on a specific peer.
func (s *Server) OverridePeerAvatar(roomId, peerId, avatar string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := peerKey(roomId, peerId)
	peer, ok := s.peers[key]
	if !ok {
		return false
	}
	peer.Avatar = avatar
	return true
}

// SendToUserPeers sends a signal to all SSE-connected peers of a given userId.
func (s *Server) SendToUserPeers(userId string, signal *Signal) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, peer := range s.peers {
		if peer.UserId == userId {
			key := peerKey(peer.RoomId, peer.PeerId)
			if clients, ok := s.sseClients[key]; ok {
				for ch := range clients {
					select {
					case ch <- signal:
					default:
					}
				}
			}
		}
	}
}

// KickOtherPeers sends a force_logout signal to all other peers of the same userId.
func (s *Server) KickOtherPeers(userId, exceptPeerId string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	kick := &Signal{Type: "force_logout"}
	for _, peer := range s.peers {
		if peer.UserId == userId && peer.PeerId != exceptPeerId {
			key := peerKey(peer.RoomId, peer.PeerId)
			if clients, ok := s.sseClients[key]; ok {
				for ch := range clients {
					select {
					case ch <- kick:
					default:
					}
				}
			}
		}
	}
}

// GetPeerUserId returns the userId for a given peer connection.
func (s *Server) GetPeerUserId(roomId, peerId string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	key := peerKey(roomId, peerId)
	if p, ok := s.peers[key]; ok {
		return p.UserId
	}
	return ""
}

func (s *Server) IsUserOnline(userId string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, peer := range s.peers {
		if peer.UserId == userId {
			return true
		}
	}
	return false
}

// DisconnectUser removes all peers for a given userId from all rooms.
func (s *Server) DisconnectUser(userId string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for key, peer := range s.peers {
		if peer.UserId == userId {
			delete(s.peers, key)
			delete(s.signals, key)
		}
	}
}

func (s *Server) GetPeerCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.peers)
}

func (s *Server) GetRoomCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rooms := make(map[string]bool)
	for _, peer := range s.peers {
		rooms[peer.RoomId] = true
	}
	return len(rooms)
}

package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type IdentityBlob struct {
	Data      interface{} `json:"data"`
	UpdatedAt int64       `json:"updatedAt"`
}

type InviteRecord struct {
	UsedBy    string `json:"usedBy"`
	CreatedBy string `json:"createdBy"`
	CreatedAt int64  `json:"createdAt"`
	UsedAt    int64  `json:"usedAt,omitempty"`
}

type GroupRecord struct {
	GroupId   string                   `json:"groupId"`
	Name      string                   `json:"name"`
	AvatarData string                  `json:"avatarData,omitempty"`
	CreatedBy string                   `json:"createdBy"`
	Members   []map[string]interface{} `json:"members"`
	CreatedAt int64                    `json:"createdAt"`
}

type InboxEntry struct {
	Id         string                 `json:"id"`
	From       string                 `json:"from,omitempty"`
	FromUserId string                 `json:"fromUserId,omitempty"`
	ToUserId   string                 `json:"toUserId,omitempty"`
	GroupId    string                 `json:"groupId,omitempty"`
	Type       string                 `json:"type"`
	Payload    map[string]interface{} `json:"payload"`
	Timestamp  int64                  `json:"timestamp"`
}

const MAX_INBOX_PER_USER = 5000
const CALL_INBOX_TTL_MS = 90000

type Storage struct {
	mu       sync.RWMutex
	dataDir  string

	identities     map[string]*IdentityBlob
	contacts       map[string][]map[string]interface{}
	groups         map[string]*GroupRecord
	bans           map[string]bool
	invites        map[string]*InviteRecord
	inboxes        map[string][]*InboxEntry
	avatars        map[string]string // userId -> avatarData URL
}

func New(dataDir string) (*Storage, error) {
	s := &Storage{
		dataDir:  dataDir,
		identities: make(map[string]*IdentityBlob),
		contacts:   make(map[string][]map[string]interface{}),
		groups:     make(map[string]*GroupRecord),
		bans:       make(map[string]bool),
		invites:    make(map[string]*InviteRecord),
		inboxes:    make(map[string][]*InboxEntry),
		avatars:    make(map[string]string),
	}

	if err := s.loadAll(); err != nil {
		return nil, err
	}

	return s, nil
}

func (s *Storage) loadAll() error {
	s.loadJSON("identity-store.json", &s.identities)
	s.loadJSON("message-inbox.json", &s.inboxes)
	s.loadJSON("contact-store.json", &s.contacts)
	s.loadJSON("group-store.json", &s.groups)
	s.loadJSON("ban-store.json", &s.bans)
	s.loadJSON("invite-store.json", &s.invites)
	s.loadJSON("avatar-store.json", &s.avatars)
	return nil
}

func (s *Storage) saveAll() {
	s.saveJSON("identity-store.json", s.identities)
	s.saveJSON("message-inbox.json", s.inboxes)
	s.saveJSON("contact-store.json", s.contacts)
	s.saveJSON("group-store.json", s.groups)
	s.saveJSON("ban-store.json", s.bans)
	s.saveJSON("invite-store.json", s.invites)
	s.saveJSON("avatar-store.json", s.avatars)
}

func (s *Storage) Close() {
	s.saveAll()
}



func (s *Storage) loadJSON(name string, target interface{}) {
	path := filepath.Join(s.dataDir, name)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	json.Unmarshal(data, target)
}

func (s *Storage) saveJSON(name string, source interface{}) {
	path := filepath.Join(s.dataDir, name)
	data, err := json.MarshalIndent(source, "", "  ")
	if err != nil {
		return
	}
	os.MkdirAll(s.dataDir, 0755)
	os.WriteFile(path, data, 0644)
}

// ==================== IDENTITY ====================

func (s *Storage) LoadIdentities() (map[string]*IdentityBlob, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]*IdentityBlob)
	for k, v := range s.identities {
		result[k] = v
	}
	return result, nil
}

func (s *Storage) SaveIdentities(identities map[string]*IdentityBlob) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.identities = identities
	s.saveJSON("identity-store.json", s.identities)
	return nil
}

func (s *Storage) StoreIdentity(userId string, data interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.identities[userId] = &IdentityBlob{
		Data:      data,
		UpdatedAt: time.Now().UnixMilli(),
	}
	s.saveJSON("identity-store.json", s.identities)
	return nil
}

func (s *Storage) GetIdentity(userId string) (interface{}, int64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.identities[userId]
	if !ok {
		return nil, 0, false
	}
	return rec.Data, rec.UpdatedAt, true
}

// ==================== INBOX ====================

func (s *Storage) GetInbox(userId string) ([]*InboxEntry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries := s.inboxes[userId]
	if entries == nil {
		return []*InboxEntry{}, nil
	}
	// Filter out expired call entries
	now := time.Now().UnixMilli()
	fresh := make([]*InboxEntry, 0, len(entries))
	for _, e := range entries {
		if e.Payload != nil {
			if ptype, ok := e.Payload["type"].(string); ok && ptype == "call" {
				if now-e.Timestamp > CALL_INBOX_TTL_MS {
					continue
				}
			}
		}
		fresh = append(fresh, e)
	}
	return fresh, nil
}

func (s *Storage) EnqueueInboxMessage(toUserId string, message map[string]interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.inboxes[toUserId] == nil {
		s.inboxes[toUserId] = make([]*InboxEntry, 0)
	}

	entry := &InboxEntry{
		Id:        generateID(),
		Type:      "app_packet",
		Payload:   message,
		Timestamp: time.Now().UnixMilli(),
	}

	if id, ok := message["id"].(string); ok {
		entry.Id = id
	}
	if from, ok := message["from"].(string); ok {
		entry.From = from
	}
	if fromUserId, ok := message["fromUserId"].(string); ok {
		entry.FromUserId = fromUserId
	}
	if groupId, ok := message["groupId"].(string); ok {
		entry.GroupId = groupId
	}

	// Dedup by packetId
	if packetId, ok := message["packetId"].(string); ok && packetId != "" {
		for _, existing := range s.inboxes[toUserId] {
			if existing.Payload != nil {
				if pid, ok := existing.Payload["packetId"].(string); ok && pid == packetId {
					return nil
				}
			}
		}
	}

	s.inboxes[toUserId] = append(s.inboxes[toUserId], entry)

	// Trim to max size
	if len(s.inboxes[toUserId]) > MAX_INBOX_PER_USER {
		s.inboxes[toUserId] = s.inboxes[toUserId][len(s.inboxes[toUserId])-MAX_INBOX_PER_USER:]
	}

	s.saveJSON("message-inbox.json", s.inboxes)
	return nil
}

func (s *Storage) AckInboxMessages(userId string, ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	idSet := make(map[string]bool)
	for _, id := range ids {
		idSet[id] = true
	}

	entries := s.inboxes[userId]
	filtered := make([]*InboxEntry, 0, len(entries))
	for _, e := range entries {
		if !idSet[e.Id] {
			filtered = append(filtered, e)
		}
	}
	s.inboxes[userId] = filtered
	s.saveJSON("message-inbox.json", s.inboxes)
	return nil
}

func (s *Storage) DeleteInboxMessages(userId string, ids []string) error {
	return s.AckInboxMessages(userId, ids)
}

func (s *Storage) RemoveInboxEntries(userId string, predicate func(*InboxEntry) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries := s.inboxes[userId]
	filtered := make([]*InboxEntry, 0, len(entries))
	for _, e := range entries {
		if !predicate(e) {
			filtered = append(filtered, e)
		}
	}
	s.inboxes[userId] = filtered
	s.saveJSON("message-inbox.json", s.inboxes)
}

func (s *Storage) DeleteInboxMessagesByGroupId(groupId string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for userId, entries := range s.inboxes {
		filtered := make([]*InboxEntry, 0, len(entries))
		for _, e := range entries {
			if e.GroupId != groupId {
				filtered = append(filtered, e)
			}
		}
		s.inboxes[userId] = filtered
	}
	s.saveJSON("message-inbox.json", s.inboxes)
}

// ==================== CONTACTS ====================

func (s *Storage) GetContacts(userId string) ([]map[string]interface{}, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	contacts := s.contacts[userId]
	if contacts == nil {
		return []map[string]interface{}{}, nil
	}
	return contacts, nil
}

func (s *Storage) SaveContacts(userId string, contacts []map[string]interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.contacts[userId] = contacts
	s.saveJSON("contact-store.json", s.contacts)
	return nil
}

func (s *Storage) AddContact(userId string, contactId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.contacts[userId] == nil {
		s.contacts[userId] = make([]map[string]interface{}, 0)
	}
	for _, c := range s.contacts[userId] {
		if c["id"] == contactId {
			return nil
		}
	}
	s.contacts[userId] = append(s.contacts[userId], map[string]interface{}{"id": contactId})
	s.saveJSON("contact-store.json", s.contacts)
	return nil
}

func (s *Storage) RemoveContact(userId string, contactId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	filtered := make([]map[string]interface{}, 0)
	for _, c := range s.contacts[userId] {
		if c["id"] != contactId {
			filtered = append(filtered, c)
		}
	}
	s.contacts[userId] = filtered
	s.saveJSON("contact-store.json", s.contacts)
	return nil
}

// ==================== GROUPS ====================

func (s *Storage) CreateGroup(group *GroupRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.groups[group.GroupId] = group
	s.saveJSON("group-store.json", s.groups)
	return nil
}

func (s *Storage) GetGroup(groupId string) (*GroupRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	group, ok := s.groups[groupId]
	if !ok {
		return nil, os.ErrNotExist
	}
	return group, nil
}

func (s *Storage) AddGroupMembers(groupId string, members []map[string]interface{}) (*GroupRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	group, ok := s.groups[groupId]
	if !ok {
		return nil, os.ErrNotExist
	}

	existing := make(map[string]bool)
	for _, m := range group.Members {
		if uid, ok := m["userId"].(string); ok {
			existing[uid] = true
		}
	}

	for _, m := range members {
		if uid, ok := m["userId"].(string); ok && !existing[uid] {
			group.Members = append(group.Members, m)
			existing[uid] = true
		}
	}

	s.groups[groupId] = group
	s.saveJSON("group-store.json", s.groups)
	return group, nil
}

func (s *Storage) GetUserGroups(userId string) ([]*GroupRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]*GroupRecord, 0)
	for _, group := range s.groups {
		for _, m := range group.Members {
			if uid, ok := m["userId"].(string); ok && uid == userId {
				result = append(result, group)
				break
			}
		}
	}
	return result, nil
}

func (s *Storage) LeaveGroup(groupId string, userId string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	group, ok := s.groups[groupId]
	if !ok {
		return false, os.ErrNotExist
	}

	filtered := make([]map[string]interface{}, 0)
	for _, m := range group.Members {
		if uid, ok := m["userId"].(string); ok && uid != userId {
			filtered = append(filtered, m)
		}
	}
	group.Members = filtered

	if len(group.Members) == 0 {
		delete(s.groups, groupId)
		s.saveJSON("group-store.json", s.groups)
		return true, nil
	}

	s.groups[groupId] = group
	s.saveJSON("group-store.json", s.groups)
	return false, nil
}

func (s *Storage) DeleteGroup(groupId string, userId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	group, ok := s.groups[groupId]
	if !ok {
		return os.ErrNotExist
	}

	isAdmin := false
	for _, m := range group.Members {
		if uid, ok := m["userId"].(string); ok && uid == userId {
			if role, ok := m["role"].(string); ok && role == "admin" {
				isAdmin = true
			}
		}
	}
	if !isAdmin {
		return os.ErrPermission
	}

	delete(s.groups, groupId)
	s.saveJSON("group-store.json", s.groups)
	return nil
}

// SendGroupMessage enqueues a message to all group members except the sender.
// Returns the number of successfully delivered messages.
func (s *Storage) SendGroupMessage(groupId string, fromUserId string, packet map[string]interface{}) (int, error) {
	s.mu.RLock()
	group, ok := s.groups[groupId]
	s.mu.RUnlock()

	if !ok {
		return 0, os.ErrNotExist
	}

	perRecipient, _ := packet["perRecipient"].(map[string]interface{})
	deliveredCount := 0
	messageId := generateID()

	for _, member := range group.Members {
		memberId, ok := member["userId"].(string)
		if !ok || memberId == fromUserId {
			continue
		}

		recipientCrypto, hasCrypto := perRecipient[memberId].(map[string]interface{})
		if !hasCrypto {
			continue
		}

		memberPayload := make(map[string]interface{})
		for k, v := range packet {
			if k != "perRecipient" {
				memberPayload[k] = v
			}
		}

		if content, ok := recipientCrypto["content"]; ok {
			memberPayload["content"] = content
		}
		if iv, ok := recipientCrypto["iv"]; ok {
			memberPayload["iv"] = iv
		}
		memberPayload["encrypted"] = true

		entry := &InboxEntry{
			Id:         messageId,
			GroupId:    groupId,
			FromUserId: fromUserId,
			Type:       "app_packet",
			Payload:    memberPayload,
			Timestamp:  time.Now().UnixMilli(),
		}

		s.mu.Lock()
		if s.inboxes[memberId] == nil {
			s.inboxes[memberId] = make([]*InboxEntry, 0)
		}
		s.inboxes[memberId] = append(s.inboxes[memberId], entry)
		if len(s.inboxes[memberId]) > MAX_INBOX_PER_USER {
			s.inboxes[memberId] = s.inboxes[memberId][len(s.inboxes[memberId])-MAX_INBOX_PER_USER:]
		}
		s.mu.Unlock()

		deliveredCount++
	}

	s.saveJSON("message-inbox.json", s.inboxes)
	return deliveredCount, nil
}

func (s *Storage) DeleteGroupMessages(groupId string, userId string, packetIds []string) (int, error) {
	pidSet := make(map[string]bool)
	for _, pid := range packetIds {
		pidSet[pid] = true
	}

	s.mu.RLock()
	group, ok := s.groups[groupId]
	s.mu.RUnlock()

	if !ok {
		return 0, os.ErrNotExist
	}

	removed := 0
	for _, member := range group.Members {
		memberId, ok := member["userId"].(string)
		if !ok {
			continue
		}

		s.mu.Lock()
		entries := s.inboxes[memberId]
		filtered := make([]*InboxEntry, 0, len(entries))
		for _, e := range entries {
			if e.Payload != nil {
				if pid, ok := e.Payload["packetId"].(string); ok && pidSet[pid] {
					removed++
					continue
				}
			}
			filtered = append(filtered, e)
		}
		s.inboxes[memberId] = filtered
		s.mu.Unlock()
	}

	s.saveJSON("message-inbox.json", s.inboxes)
	return removed, nil
}

// ==================== BANS ====================

func (s *Storage) BanUser(userId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bans[userId] = true
	s.saveJSON("ban-store.json", s.bans)
	return nil
}

func (s *Storage) UnbanUser(userId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.bans, userId)
	s.saveJSON("ban-store.json", s.bans)
	return nil
}

func (s *Storage) GetBannedUsers() ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]string, 0, len(s.bans))
	for userId := range s.bans {
		result = append(result, userId)
	}
	return result, nil
}

func (s *Storage) IsBanned(userId string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bans[userId]
}

// ==================== INVITES ====================

func (s *Storage) LoadInvites() (map[string]*InviteRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]*InviteRecord)
	for k, v := range s.invites {
		result[k] = v
	}
	return result, nil
}

func (s *Storage) SaveInvites(invites map[string]*InviteRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.invites = invites
	s.saveJSON("invite-store.json", s.invites)
	return nil
}

func (s *Storage) CreateInvite(code string, invite *InviteRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.invites[code] = invite
	s.saveJSON("invite-store.json", s.invites)
	return nil
}

func (s *Storage) UseInvite(code string, userId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	invite, ok := s.invites[code]
	if !ok {
		return os.ErrNotExist
	}
	if invite.UsedBy != "" {
		return os.ErrExist
	}
	invite.UsedBy = userId
	invite.UsedAt = time.Now().UnixMilli()
	s.invites[code] = invite
	s.saveJSON("invite-store.json", s.invites)
	return nil
}

// ==================== AVATAR ====================

func (s *Storage) StoreAvatar(userId string, avatarData string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.avatars[userId] = avatarData
	s.saveJSON("avatar-store.json", s.avatars)
	return nil
}

func (s *Storage) GetAvatar(userId string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	data, ok := s.avatars[userId]
	return data, ok
}

func (s *Storage) ListIdentities() map[string]*IdentityBlob {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]*IdentityBlob)
	for k, v := range s.identities {
		result[k] = v
	}
	return result
}

func (s *Storage) GetAvatarForAdmin(userId string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.avatars[userId]
}

func generateID() string {
	const chars = "0123456789abcdef"
	b := make([]byte, 32)
	for i := range b {
		b[i] = chars[time.Now().UnixNano()%16]
	}
	return string(b)
}

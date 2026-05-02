SERVER_IP = 157.180.66.111
SSH_KEY   = ~/.ssh/ap-mcp

ssh:
	ssh -i $(SSH_KEY) root@$(SERVER_IP)

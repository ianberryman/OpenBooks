package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.model.Account;
import org.openbooks.openbooksapi.core.model.ChartOfAccounts;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Optional;

@RestController
public class AccountController {

	@Autowired
	private ChartOfAccounts coa;
	
	@GetMapping("/accounts")
	public List<Account> getAccounts(@RequestParam Optional<String> accountNumber) {
		return accountNumber.isPresent() 
				? coa.getAccountsByAccountNumber(accountNumber.get()) 
				: coa.getAccounts();
	}
	
	@PostMapping("/accounts")
	public ResponseEntity<ActionResponse> createAccount(@RequestBody Account account) {
		coa.createAccount(account);
		
		return ResponseEntity.created(null).body(new ActionResponse("Account created"));
	}
	
	@GetMapping("/accounts/{id}")
	public Account getAccountById(@PathVariable Long id) {
		return coa.getAccountById(id);
	}
	
	@DeleteMapping("/accounts/{id}")
	public ResponseEntity<ActionResponse> deleteAccount(@PathVariable Long id) {
		coa.deleteAccount(id);
		
		return ResponseEntity.ok(new ActionResponse("Account deleted"));
	}
}

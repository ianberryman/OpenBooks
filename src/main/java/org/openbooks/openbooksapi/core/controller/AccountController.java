package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.model.Account;
import org.openbooks.openbooksapi.core.model.ChartOfAccountsService;
import org.openbooks.openbooksapi.core.model.CompanyService;
import org.openbooks.openbooksapi.core.model.Transaction;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.persistence.EntityExistsException;
import java.util.List;
import java.util.Optional;

@RestController
@RequestMapping("/accounts")
public class AccountController {

    @Autowired
    private ChartOfAccountsService coa;

    @Autowired
    private CompanyService companies;

    @GetMapping
    public List<Account> getAccounts(@RequestParam Optional<String> accountNumber) {
        return accountNumber.isPresent()
                ? coa.getAccountsByAccountNumber(accountNumber.get())
                : coa.getAccounts();
    }

    @GetMapping("/{id}")
    public Account getAccountById(@PathVariable Long id) {
        return coa.getAccountById(id).get();
    }

    @GetMapping("/{id}/transactions")
    public List<Transaction> getTransactionsForAccount(@PathVariable Long id) {
        return coa.getTransactionsForAccount(coa.getAccountById(id).get());
    }

    @PostMapping
    public ResponseEntity<Account> createAccount(@RequestBody Account account) {
        // throw error if account exists
        //if (!account.idIsNull() && coa.getAccountById(account.getId()).isPresent()) {
        if(!account.idIsNull() && coa.accountExists(account)) {
            throw new EntityExistsException("Account with ID " + account.getId() + " already exists");
        }

        Account newAccount = coa.createAccount(account);

        return ResponseEntity.created(null).body(newAccount);
    }

    @PutMapping
    public ResponseEntity<Account> updateAccount(@RequestBody Account account) {
        // check if id exists, will throw error if account doesn't exist
        coa.accountExists(account);

        // update Account and return new object data
        return ResponseEntity.ok().body(coa.updateAccount(account));
    }


    @DeleteMapping("/{id}")
    public ResponseEntity<ActionResponse> deleteAccount(@PathVariable Long id) {
        coa.deleteAccount(id);

        return ResponseEntity.ok(new ActionResponse("Account deleted"));
    }
}


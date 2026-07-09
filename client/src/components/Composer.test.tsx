import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserDTO } from '@messenger/shared';
import Composer from './Composer';

const me: UserDTO = { id: 1, email: 'me@example.com', displayName: 'Me', isBot: false };
const alice: UserDTO = { id: 2, email: 'alice@example.com', displayName: 'Alice', isBot: false };

describe('Composer @mentions', () => {
  it('autocompletes a mention on Enter without submitting, then sends the picked id', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me, alice]} meId={me.id} />);

    const input = screen.getByPlaceholderText('Aa');

    // Typing '@al' opens the dropdown with the (non-me) member Alice.
    await userEvent.type(input, '@al');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /alice/i })).toBeInTheDocument();

    // Enter selects the highlighted candidate and must NOT submit the form.
    await userEvent.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('@Alice ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // A subsequent real send carries the content plus the mentioned id.
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('@Alice', [alice.id]);
  });

  it('excludes me from the candidate list', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} members={[me, alice]} meId={me.id} />);

    await userEvent.type(screen.getByPlaceholderText('Aa'), '@');
    expect(screen.getByRole('option', { name: /alice/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^me$/i })).not.toBeInTheDocument();
  });
});
